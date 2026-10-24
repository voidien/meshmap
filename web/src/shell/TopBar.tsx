import type { ReactNode } from "react";
import { Popover } from "./Popover";

export interface TopBarProps {
  projects: { id: string; name: string }[];
  activeId: string;
  projectName: string;
  canRename: boolean;
  onRename: (name: string) => void;
  canFlip: boolean;
  onFlip: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDuplicate: () => void;
  onShare: () => void;
  onPublish: () => void;
  onHistory: () => void;
  onCompare: () => void;
  onImportExport: () => void;
  onSettings: () => void;
  onDelete: () => void;
  canDelete: boolean;
  /** viewing a published project: the project actions do not apply */
  published: boolean;
  onPalette: () => void;
  status: ReactNode;
  onField: () => void;
  fieldDisabled: boolean;
  user: { displayName: string; isAdmin: boolean };
  onHelp: () => void;
  onAccount: () => void;
  onAdmin: () => void;
  onSignOut: () => void;
  browserOpen: boolean;
  inspectorOpen: boolean;
  onToggleBrowser: () => void;
  onToggleInspector: () => void;
}

/** The new layout's top bar: project menu, search, status, mode and account. */
export function TopBar(p: TopBarProps) {
  const item = (close: () => void, label: string, run: () => void, opts: { danger?: boolean; disabled?: boolean; id?: string } = {}) => (
    <button
      key={label}
      id={opts.id}
      role="menuitem"
      className={opts.danger ? "danger-text" : ""}
      disabled={opts.disabled}
      onClick={() => {
        close();
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <header className="topbar">
      <button className={`iconbtn ${p.browserOpen ? "on" : ""}`} onClick={p.onToggleBrowser} aria-pressed={p.browserOpen} aria-label="Show or hide the lists (Nodes, Links, Issues)" title="Lists (B)" id="toggle-browser">
        ☰
      </button>
      <Popover id="project-menu" className="projbtn" label={<><b>{p.projectName || "Untitled"}</b> ▾</>} title="Project menu">
        {(close) => (
          <>
            <div className="popsection">Projects</div>
            <div className="projlist">
              {p.projects.map((x) => (
                <button key={x.id} role="menuitemradio" aria-checked={x.id === p.activeId} className={x.id === p.activeId ? "sel" : ""} onClick={() => (close(), p.onSelect(x.id))}>
                  {x.name}
                </button>
              ))}
            </div>
            {item(close, "Back to the previous project (`)", p.onFlip, { disabled: !p.canFlip })}
            <hr />
            <label className="popfield">
              <span>Project name</span>
              <input value={p.projectName} readOnly={!p.canRename} onChange={(e) => p.onRename(e.target.value)} aria-label="Project name" title={p.canRename ? "" : "Only the owner can rename"} />
            </label>
            {item(close, "New project", p.onNew, { disabled: p.published })}
            {item(close, "Duplicate project", p.onDuplicate, { disabled: p.published })}
            <hr />
            {item(close, "Settings…", p.onSettings, { disabled: p.published, id: "menu-settings" })}
            {item(close, "History…", p.onHistory, { disabled: p.published, id: "menu-history" })}
            {item(close, "Compare with another project…", p.onCompare, { disabled: p.published })}
            {item(close, "Import / export…", p.onImportExport, { id: "menu-export" })}
            <hr />
            {item(close, "Share…", p.onShare, { disabled: p.published })}
            {item(close, "Publish…", p.onPublish, { disabled: p.published })}
            {item(close, "Delete project…", p.onDelete, { danger: true, disabled: !p.canDelete })}
          </>
        )}
      </Popover>
      <button className="searchbtn" id="open-palette" onClick={p.onPalette} aria-label="Search and commands (Ctrl+K)">
        <span>🔍 Go to a node, run a command…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <span className="spacer" />
      <div className="topstatus">{p.status}</div>
      <div className="modeswitch" role="group" aria-label="Mode">
        <button className="on" aria-pressed="true">
          Plan
        </button>
        <button id="mode-field" onClick={p.onField} disabled={p.fieldDisabled} aria-pressed="false" title="Standing at a site: GPS, predicted signal here, record readings">
          Field
        </button>
      </div>
      <Popover id="avatar-menu" align="right" className="avatar" label={<span aria-label={`Account menu for ${p.user.displayName}`}>{(p.user.displayName.trim()[0] ?? "?").toUpperCase()}</span>} title={p.user.displayName}>
        {(close) => (
          <>
            <div className="popsection">{p.user.displayName}</div>
            {p.published ? null : item(close, "Field mode", p.onField, { disabled: p.fieldDisabled, id: "menu-field" })}
            {item(close, "Account…", p.onAccount)}
            {p.user.isAdmin ? item(close, "Admin…", p.onAdmin) : null}
            {item(close, "Help", p.onHelp, { id: "help-btn-v2" })}
            <hr />
            {item(close, "Sign out", p.onSignOut)}
          </>
        )}
      </Popover>
      <button className={`iconbtn ${p.inspectorOpen ? "on" : ""}`} onClick={p.onToggleInspector} aria-pressed={p.inspectorOpen} aria-label="Show or hide the details panel" title="Details (I)" id="toggle-inspector">
        ◧
      </button>
    </header>
  );
}
