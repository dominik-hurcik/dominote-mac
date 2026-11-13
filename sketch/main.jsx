// Whiteboard: Excalidraw mounted into a plain DOM node. app.js loads this file only when a sketch opens.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, serializeAsJSON, restoreElements, CaptureUpdateAction } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

const UI = {
  canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: false, saveAsImage: true },
};

function parse(json) {
  try {
    const d = JSON.parse(json || '{}');
    return { elements: d.elements || [], appState: d.appState || {}, files: d.files || {} };
  } catch {
    return { elements: [], appState: {}, files: {} };
  }
}

// Returns a small handle: { json(), load(json), setTheme(theme), unmount() }.
// onChange fires only when the drawing itself changes, not on every pointer move or selection.
export function mount(el, { json, theme, onChange }) {
  const root = createRoot(el);
  let api = null, last = null;
  const changed = (elements, appState, files) => {
    const key = elements.map(e => e.id + ':' + e.version).join() + '|' + appState.viewBackgroundColor + '|' + Object.keys(files).join();
    if (last !== null && key !== last) onChange();
    last = key;
  };
  const render = t =>
    root.render(
      <Excalidraw
        initialData={parse(json)}
        theme={t}
        UIOptions={UI}
        excalidrawAPI={a => (api = a)}
        onChange={changed}
      />,
    );
  render(theme);
  return {
    json: () => (api ? serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local') : null),
    load(next) {
      if (!api) return;
      const d = parse(next);
      api.addFiles(Object.values(d.files));
      // Undoable, so ⌘Z reverts a restored version or an AI agent's edit.
      api.updateScene({ elements: restoreElements(d.elements, null), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    },
    setTheme: render,
    unmount: () => root.unmount(),
  };
}
