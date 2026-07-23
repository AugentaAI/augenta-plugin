/**
 * Tests for turn-cursor.ts — the per-transcript TURN ordinal that groups a turn's events.
 *
 * Contract: 0 before the first bump; bump increments and persists; transcripts are independent;
 * the value survives across TurnState instances (it's the same on-disk map).
 *
 * Run: bun test ingest/turn-cursor.test.ts
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnState } from "./turn-cursor";

describe("TurnState", () => {
  let home: string;
  beforeEach(() => (home = mkdtempSync(join(tmpdir(), "aug-turn-"))));
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("is 0 for an unseen transcript", () => {
    expect(new TurnState(home).get("/x/t.jsonl")).toBe(0);
  });

  test("bump increments and persists the ordinal", () => {
    const s = new TurnState(home);
    expect(s.bump("/a.jsonl")).toBe(1);
    expect(s.bump("/a.jsonl")).toBe(2);
    expect(s.get("/a.jsonl")).toBe(2);
  });

  test("keeps transcripts independent", () => {
    const s = new TurnState(home);
    s.bump("/a.jsonl");
    s.bump("/a.jsonl");
    s.bump("/b.jsonl");
    expect(s.get("/a.jsonl")).toBe(2);
    expect(s.get("/b.jsonl")).toBe(1);
  });

  test("survives across instances (same on-disk map)", () => {
    new TurnState(home).bump("/a.jsonl");
    expect(new TurnState(home).get("/a.jsonl")).toBe(1);
  });
});
