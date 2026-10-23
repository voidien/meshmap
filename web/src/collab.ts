/** Publishing, comments and field readings (see `crates/meshmap-server/src/collab.rs`). */
import type { Project } from "./types";

export interface PersonRef {
  id: string;
  username: string;
  displayName: string;
}

export interface Publication {
  id: string;
  /** Only present on your own publications. */
  projectId?: string | null;
  title: string;
  description: string;
  owner: PersonRef;
  nodeCount: number;
  publishedAt: number;
  updatedAt: number;
  commentCount: number;
  mine: boolean;
  /** Your project changed since you published (own publications only). */
  outdated?: boolean | null;
  data?: Pick<Project, "nodes" | "settings" | "overlays">;
}

export type CommentTarget = { kind: "project" } | { kind: "node"; ref: string } | { kind: "link"; ref: string };

export interface Comment {
  id: string;
  author: PersonRef | null;
  targetKind: "project" | "node" | "link";
  targetRef: string;
  body: string;
  createdAt: number;
  resolved: boolean;
  canDelete: boolean;
  canResolve: boolean;
}

/** Where a comment thread lives: a project (its collaborators) or a published copy (everyone). */
export type CommentScope = { kind: "project"; id: string } | { kind: "publication"; id: string };

export const commentsUrl = (s: CommentScope) => (s.kind === "project" ? `/api/projects/${s.id}/comments` : `/api/published/${s.id}/comments`);

export interface FieldReading {
  id: string;
  nodeRef: string | null;
  lat: number;
  lon: number;
  accuracyM: number | null;
  rssiDbm: number | null;
  snrDb: number | null;
  note: string;
  takenAt: number;
  by?: string | null;
  canDelete?: boolean;
}

/** "3 minutes ago", "yesterday", or a date. */
export function ago(unixSeconds: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
