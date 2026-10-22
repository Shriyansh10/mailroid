/**
 * getCommunicationMetrics' people, as the model may see them.
 *
 * A colleague is named, never addressed. Each row carries an opaque `ref` the
 * model hands back to ask about that one person; the server maps refs to
 * addresses inside the caller's visible scope, so a ref grants nothing outside
 * it. A person with no name on record is shown as "[EMAIL]".
 */
import { maskForModel } from "./model-masking.ts";

export function metricsPersonForModel(person: { name?: string | null }, ref: string): { ref: string; name: string } {
  const name = person.name?.trim() ? maskForModel(person.name) : "";
  return { ref, name: name && !name.includes("[EMAIL]") ? name : "[EMAIL]" };
}

/** People in scope whose name contains the query, case-insensitively. Never matches on address. */
export function matchPeopleByName<T extends { name?: string | null }>(people: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return people.filter((p) => (p.name ?? "").toLowerCase().includes(q));
}
