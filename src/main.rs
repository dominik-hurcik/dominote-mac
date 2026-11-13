// Dominote: notes are plain Markdown files in folders under one root directory.
// That root is the whole "database", so AI agents and other tools can read and edit it directly.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn root() -> PathBuf {
    let dir = std::env::var("DOMINOTE_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into())).join("Documents/Dominote")
    });
    let _ = fs::create_dir_all(&dir);
    dir
}

/// Resolve a path relative to the notes root. Rejects anything that could escape it.
fn resolve(rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if !p.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err(format!("invalid path: {rel}"));
    }
    Ok(root().join(p))
}

fn rel(p: &Path) -> String {
    p.strip_prefix(root()).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim().replace(['/', '\\', ':'], "-");
    if n.is_empty() || n.starts_with('.') {
        return Err("invalid name".into());
    }
    Ok(n)
}

/// First free path like "Untitled.md", "Untitled 2.md", ...
fn unique(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{base}{ext}"));
    let mut i = 2;
    while p.exists() {
        p = dir.join(format!("{base} {i}{ext}"));
        i += 1;
    }
    p
}

#[derive(Serialize)]
struct Node {
    name: String,
    path: String,
    dir: bool,
    /// A linked folder: a symlink to a folder elsewhere on disk, shown like any other folder.
    link: bool,
    children: Vec<Node>,
}

/// Linked folders can contain links back up the tree, so walks stop at this depth.
const MAX_DEPTH: usize = 12;

fn walk(dir: &Path, depth: usize) -> Vec<Node> {
    if depth > MAX_DEPTH {
        return vec![];
    }
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Node> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let p = e.path();
            let link = e.file_type().is_ok_and(|t| t.is_symlink());
            if p.is_dir() {
                Some(Node { name, path: rel(&p), dir: true, link, children: walk(&p, depth + 1) })
            } else {
                let title = name.strip_suffix(".md").or_else(|| name.strip_suffix(SKETCH))?.to_string();
                Some(Node { name: title, path: rel(&p), dir: false, link: false, children: vec![] })
            }
        })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

#[tauri::command]
fn root_dir() -> String {
    root().to_string_lossy().to_string()
}

/// Whiteboards are Excalidraw files. They live in the Sketches folder, shown as its own sidebar section.
const SKETCH: &str = ".excalidraw";
const EMPTY_SKETCH: &str = r#"{"type":"excalidraw","version":2,"source":"dominote","elements":[],"appState":{},"files":{}}"#;

#[tauri::command]
fn tree() -> Vec<Node> {
    let _ = fs::create_dir_all(root().join("Sketches"));
    walk(&root(), 0)
}

#[tauri::command]
fn read_note(path: String) -> Result<String, String> {
    fs::read_to_string(resolve(&path)?).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_note(path: String, content: String) -> Result<(), String> {
    let p = resolve(&path)?;
    // Write to a temp file then rename, so a crash mid-write never corrupts a note.
    let tmp = p.with_file_name(format!(".{}.tmp", p.file_name().unwrap().to_string_lossy()));
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    backup(&path, &p, &content);
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

// ---------- page history ----------
// Before a save overwrites a page, its previous text is copied to
// <root>/.dominote/history/<page path>/<unix seconds>.md, at most once every 10 minutes.
// That keeps a version from before each editing session, so a bad edit can be rolled back
// even after the app restarts. Hidden from the sidebar and search like any dot folder.
const BACKUP_EVERY: u64 = 10 * 60;
const KEEP_VERSIONS: usize = 100;

fn history_dir(rel_path: &str) -> PathBuf {
    root().join(".dominote/history").join(rel_path)
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// Version ids (unix seconds), newest first.
fn version_ids(dir: &Path) -> Vec<u64> {
    let mut ids: Vec<u64> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".md")?.parse().ok())
        .collect();
    ids.sort_unstable_by(|a, b| b.cmp(a));
    ids
}

fn backup(rel_path: &str, p: &Path, new: &str) {
    let Ok(old) = fs::read_to_string(p) else { return };
    if old.trim().is_empty() || old == new {
        return;
    }
    let dir = history_dir(rel_path);
    let ids = version_ids(&dir);
    let t = now();
    if ids.first().is_some_and(|&last| t.saturating_sub(last) < BACKUP_EVERY) {
        return;
    }
    if fs::create_dir_all(&dir).is_err() || fs::write(dir.join(format!("{t}.md")), old).is_err() {
        return;
    }
    for id in ids.iter().skip(KEEP_VERSIONS - 1) {
        let _ = fs::remove_file(dir.join(format!("{id}.md")));
    }
}

/// Keep a page's or folder's history attached to it after a rename or move.
fn move_history(from: &str, to: &str) {
    let (a, b) = (history_dir(from), history_dir(to));
    if a.exists() && !b.exists() {
        if let Some(parent) = b.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::rename(a, b);
    }
}

#[derive(Serialize)]
struct Version {
    id: String,
    words: usize,
}

#[tauri::command]
fn history(path: String) -> Result<Vec<Version>, String> {
    resolve(&path)?;
    let dir = history_dir(&path);
    Ok(version_ids(&dir)
        .into_iter()
        .map(|id| Version {
            id: id.to_string(),
            words: fs::read_to_string(dir.join(format!("{id}.md"))).map_or(0, |s| s.split_whitespace().count()),
        })
        .collect())
}

#[tauri::command]
fn read_version(path: String, id: String) -> Result<String, String> {
    resolve(&path)?;
    let id: u64 = id.parse().map_err(|_| "invalid version")?;
    fs::read_to_string(history_dir(&path).join(format!("{id}.md"))).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_note(dir: String, sketch: Option<bool>) -> Result<String, String> {
    let d = resolve(&dir)?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let sketch = sketch.unwrap_or(false);
    let p = unique(&d, "Untitled", if sketch { SKETCH } else { ".md" });
    fs::write(&p, if sketch { EMPTY_SKETCH } else { "" }).map_err(|e| e.to_string())?;
    Ok(rel(&p))
}

#[tauri::command]
fn create_folder(dir: String) -> Result<String, String> {
    let p = unique(&resolve(&dir)?, "New folder", "");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(rel(&p))
}

#[tauri::command]
fn rename(path: String, name: String) -> Result<String, String> {
    let from = resolve(&path)?;
    let mut name = clean_name(&name)?;
    if from.is_file() {
        name.push_str(if path.ends_with(SKETCH) { SKETCH } else { ".md" });
    }
    let to = from.with_file_name(name);
    if to == from {
        return Ok(path);
    }
    // Case-only renames are fine on macOS's case-insensitive disk; any other clash is not.
    if to.exists() && to.to_string_lossy().to_lowercase() != from.to_string_lossy().to_lowercase() {
        return Err("a page or folder with that name already exists".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    move_history(&path, &rel(&to));
    Ok(rel(&to))
}

#[tauri::command]
fn move_item(path: String, dir: String) -> Result<String, String> {
    let from = resolve(&path)?;
    let d = resolve(&dir)?;
    if d.starts_with(&from) {
        return Err("cannot move a folder into itself".into());
    }
    let to = d.join(from.file_name().ok_or("invalid path")?);
    if to == from {
        return Ok(path);
    }
    if to.exists() {
        return Err("an item with that name already exists there".into());
    }
    fs::rename(&from, &to).map_err(|e| e.to_string())?;
    move_history(&path, &rel(&to));
    Ok(rel(&to))
}

#[tauri::command]
fn delete(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("refusing to delete the notes root".into());
    }
    let p = resolve(&path)?;
    // A linked folder is only unlinked. The real folder and its files stay where they are.
    if fs::symlink_metadata(&p).is_ok_and(|m| m.file_type().is_symlink()) {
        return fs::remove_file(&p).map_err(|e| e.to_string());
    }
    trash::delete(p).map_err(|e| e.to_string())
}

// ---------- linked folders ----------
// A folder elsewhere on disk shows up in the sidebar through a symlink inside the notes root.
// Its pages open, save and search like any other, and agents reading the root see it too.

fn link_into(dir: &str, target: &Path) -> Result<String, String> {
    let target = target.canonicalize().map_err(|e| e.to_string())?;
    let root = root().canonicalize().map_err(|e| e.to_string())?;
    if !target.is_dir() {
        return Err("not a folder".into());
    }
    if target.starts_with(&root) || root.starts_with(&target) {
        return Err("that folder is already part of your notes".into());
    }
    let name = target.file_name().map_or("Linked".into(), |n| n.to_string_lossy().to_string());
    let at = unique(&resolve(dir)?, &name, "");
    std::os::unix::fs::symlink(&target, &at).map_err(|e| e.to_string())?;
    Ok(rel(&at))
}

/// Ask for a folder with the macOS picker, then link it into `dir`. None when the picker is cancelled.
#[tauri::command]
async fn link_folder(dir: String) -> Result<Option<String>, String> {
    let out = std::process::Command::new("osascript")
        // `activate` brings the picker in front of the Dominote window.
        .args(["-e", "activate", "-e", r#"POSIX path of (choose folder with prompt "Link a folder into Dominote")"#])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(None);
    }
    let picked = String::from_utf8_lossy(&out.stdout).trim().to_string();
    link_into(&dir, Path::new(&picked)).map(Some)
}

#[derive(Serialize)]
struct Hit {
    path: String,
    title: String,
    snippet: String,
}

#[tauri::command]
fn search(query: String) -> Vec<Hit> {
    fn notes(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                notes(&p, out, depth + 1);
            } else if p.extension().is_some_and(|x| x == "md" || x == "excalidraw") {
                out.push(p);
            }
        }
    }
    let mut files = vec![];
    notes(&root(), &mut files, 0);
    let q = query.to_lowercase();
    let mut title_hits = vec![];
    let mut body_hits = vec![];
    for p in files {
        let title = p.file_stem().unwrap().to_string_lossy().to_string();
        let path = rel(&p);
        if title.to_lowercase().contains(&q) {
            title_hits.push(Hit { snippet: path.clone(), path, title });
        } else if !q.is_empty() && p.extension().is_some_and(|x| x == "md") {
            let body = fs::read_to_string(&p).unwrap_or_default();
            if let Some(i) = body.to_lowercase().find(&q) {
                // Snippet around the match; lowercase can shift byte offsets, so clamp to char boundaries.
                let line_start = body.get(..i).and_then(|s| s.rfind('\n')).map_or(0, |n| n + 1);
                let snippet: String = body[line_start..].chars().take(90).collect();
                body_hits.push(Hit { path, title, snippet });
            }
        }
    }
    title_hits.sort_by_key(|h| h.title.to_lowercase());
    title_hits.extend(body_hits);
    title_hits.truncate(50);
    title_hits
}

/// Export as PDF: open the macOS print dialog, which has a PDF button.
/// Tauri's own print uses zero page margins, so long pages ran to the top edge of page 2 and on.
#[tauri::command]
fn print_page(window: tauri::WebviewWindow, title: String) -> Result<(), String> {
    window
        .with_webview(move |wv| unsafe {
            use objc2_app_kit::NSPrintInfo;
            use objc2_web_kit::WKWebView;
            let view = &*(wv.inner() as *const WKWebView);
            let info = NSPrintInfo::sharedPrintInfo();
            info.setTopMargin(43.0); // 0.6 inch
            info.setBottomMargin(43.0);
            info.setLeftMargin(50.0); // 0.7 inch
            info.setRightMargin(50.0);
            let op = view.printOperationWithPrintInfo(&info);
            op.setJobTitle(Some(&objc2_foundation::NSString::from_str(&title))); // the PDF's default file name
            op.setCanSpawnSeparateThread(true);
            if let Some(w) = view.window() {
                op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(&w, None, None, std::ptr::null_mut());
            }
        })
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            root_dir, tree, read_note, write_note, create_note, create_folder, rename, move_item, delete, search,
            history, read_version, link_folder, print_page
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dominote");
}

#[cfg(test)]
mod tests {
    use super::*;
    // Tests that point DOMINOTE_DIR at a temp folder must not run at the same time.
    static ROOT: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn resolve_rejects_escapes() {
        assert!(resolve("../etc/passwd").is_err());
        assert!(resolve("/etc/passwd").is_err());
        assert!(resolve("a/../../b").is_err());
        assert!(resolve("Work/Ideas.md").is_ok());
    }

    #[test]
    fn sketch_rename_keeps_extension() {
        let _lock = ROOT.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("dominote-sketch-{}", std::process::id()));
        std::env::set_var("DOMINOTE_DIR", &dir);
        let _ = fs::remove_dir_all(&dir);
        let p = create_note("Sketches".into(), Some(true)).unwrap();
        assert_eq!(p, "Sketches/Untitled.excalidraw");
        assert_eq!(rename(p, "Plan".into()).unwrap(), "Sketches/Plan.excalidraw");
        let t = tree();
        assert_eq!(t[0].name, "Sketches");
        assert_eq!(t[0].children[0].name, "Plan");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn linked_folder_shows_and_unlinks_without_touching_files() {
        let _lock = ROOT.lock().unwrap();
        let base = std::env::temp_dir().join(format!("dominote-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let (dir, ext) = (base.join("notes"), base.join("Context"));
        fs::create_dir_all(ext.join("deep")).unwrap();
        fs::write(ext.join("deep/spec.md"), "hello").unwrap();
        std::os::unix::fs::symlink(&ext, ext.join("deep/loop")).unwrap();
        std::env::set_var("DOMINOTE_DIR", &dir);
        let _ = root();
        assert!(link_into("", &dir).is_err(), "root can't link itself");
        assert_eq!(link_into("", &ext).unwrap(), "Context");
        let t = tree();
        let c = t.iter().find(|n| n.name == "Context").unwrap();
        assert!(c.link);
        assert_eq!(read_note("Context/deep/spec.md".into()).unwrap(), "hello");
        write_note("Context/deep/spec.md".into(), "edited".into()).unwrap();
        assert_eq!(fs::read_to_string(ext.join("deep/spec.md")).unwrap(), "edited");
        assert!(search("edited".into()).iter().any(|h| h.path == "Context/deep/spec.md"));
        delete("Context".into()).unwrap();
        assert!(!dir.join("Context").exists());
        assert!(ext.join("deep/spec.md").exists(), "unlinking keeps the real files");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn clean_name_strips_separators() {
        assert_eq!(clean_name(" a/b ").unwrap(), "a-b");
        assert!(clean_name("  ").is_err());
        assert!(clean_name(".hidden").is_err());
    }

    #[test]
    fn backup_keeps_old_text_once_per_interval() {
        let _lock = ROOT.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("dominote-test-{}", std::process::id()));
        std::env::set_var("DOMINOTE_DIR", &dir);
        let _ = fs::remove_dir_all(&dir);
        write_note("a.md".into(), "one".into()).unwrap();
        write_note("a.md".into(), "two".into()).unwrap();
        write_note("a.md".into(), "three".into()).unwrap();
        let v = history("a.md".into()).unwrap();
        assert_eq!(v.len(), 1, "second change within 10 minutes is not backed up");
        assert_eq!(read_version("a.md".into(), v[0].id.clone()).unwrap(), "one");
        rename("a.md".into(), "b".into()).unwrap();
        assert_eq!(history("b.md".into()).unwrap().len(), 1);
        assert!(read_version("b.md".into(), "../../x".into()).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
