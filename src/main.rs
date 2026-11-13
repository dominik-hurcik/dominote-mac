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
    children: Vec<Node>,
}

fn walk(dir: &Path) -> Vec<Node> {
    let Ok(rd) = fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Node> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            let p = e.path();
            if p.is_dir() {
                Some(Node { name, path: rel(&p), dir: true, children: walk(&p) })
            } else {
                let title = name.strip_suffix(".md")?.to_string();
                Some(Node { name: title, path: rel(&p), dir: false, children: vec![] })
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

#[tauri::command]
fn tree() -> Vec<Node> {
    walk(&root())
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
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_note(dir: String) -> Result<String, String> {
    let d = resolve(&dir)?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let p = unique(&d, "Untitled", ".md");
    fs::write(&p, "").map_err(|e| e.to_string())?;
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
        name.push_str(".md");
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
    Ok(rel(&to))
}

#[tauri::command]
fn delete(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("refusing to delete the notes root".into());
    }
    trash::delete(resolve(&path)?).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Hit {
    path: String,
    title: String,
    snippet: String,
}

#[tauri::command]
fn search(query: String) -> Vec<Hit> {
    fn notes(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if e.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                notes(&p, out);
            } else if p.extension().is_some_and(|x| x == "md") {
                out.push(p);
            }
        }
    }
    let mut files = vec![];
    notes(&root(), &mut files);
    let q = query.to_lowercase();
    let mut title_hits = vec![];
    let mut body_hits = vec![];
    for p in files {
        let title = p.file_stem().unwrap().to_string_lossy().to_string();
        let path = rel(&p);
        if title.to_lowercase().contains(&q) {
            title_hits.push(Hit { snippet: path.clone(), path, title });
        } else if !q.is_empty() {
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            root_dir, tree, read_note, write_note, create_note, create_folder, rename, move_item, delete, search
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dominote");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        assert!(resolve("../etc/passwd").is_err());
        assert!(resolve("/etc/passwd").is_err());
        assert!(resolve("a/../../b").is_err());
        assert!(resolve("Work/Ideas.md").is_ok());
    }

    #[test]
    fn clean_name_strips_separators() {
        assert_eq!(clean_name(" a/b ").unwrap(), "a-b");
        assert!(clean_name("  ").is_err());
        assert!(clean_name(".hidden").is_err());
    }
}
