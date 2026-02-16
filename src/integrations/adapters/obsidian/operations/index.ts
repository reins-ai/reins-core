/**
 * Obsidian operations barrel export.
 *
 * Re-exports all four Obsidian vault operations:
 * search-notes, read-note, create-note, list-notes.
 */

export { searchNotes, type SearchNotesParams, type SearchNoteMatch } from "./search-notes";
export { readNote, type ReadNoteParams } from "./read-note";
export { createNote, type CreateNoteParams } from "./create-note";
export { listNotes, type ListNotesParams } from "./list-notes";
