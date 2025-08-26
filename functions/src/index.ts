import * as functions from "firebase-functions/v1";
import express from "express";
import cors from "cors";
import type { Request, Response } from "express";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const db = getFirestore();
const app = express();
app.use(cors({ origin: true }));          // fine for mobile + local testing
app.use(express.json({ limit: "1mb" }));  // cap request body

type AlivePairs = Array<[number, number]>;       // API in/out
type AliveDocs  = Array<{ r: number; c: number }>; // Firestore storage

// const toSetFromPairs = (alive: AlivePairs): Set<string> => {
//   const s = new Set<string>();
//   for (const [r, c] of alive) s.add(`${r},${c}`);
//   return s;
// };
const toSetFromDocs = (alive: AliveDocs): Set<string> => {
  const s = new Set<string>();
  for (const { r, c } of alive) s.add(`${r},${c}`);
  return s;
};
const pairsFromSet = (s: Set<string>): AlivePairs =>
  Array.from(s, k => k.split(",").map(Number) as [number, number]);

const docsFromSet = (s: Set<string>): AliveDocs =>
  Array.from(s, k => {
    const [r, c] = k.split(",").map(Number);
    return { r, c };
  });

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function nextGeneration(alive: Set<string>, rows: number, cols: number): Set<string> {
  const counts = new Map<string, number>();
  const inc = (r: number, c: number) => {
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;
    const k = `${r},${c}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  };
  for (const key of alive) {
    const [r, c] = key.split(",").map(Number);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        inc(r + dr, c + dc);
      }
    }
  }
  const next = new Set<string>();
  for (const [cell, n] of counts) {
    const wasAlive = alive.has(cell);
    if ((wasAlive && (n === 2 || n === 3)) || (!wasAlive && n === 3)) next.add(cell);
  }
  return next;
}

// POST /boards  { rows, cols, alive?: [[r,c],...] }
app.post("/boards", async (req: Request, res: Response): Promise<void> => {
  try {
    const { rows, cols, alive } = req.body || {};
    if (!Number.isInteger(rows) || !Number.isInteger(cols)) {
      res.status(400).send("rows/cols required");
      return;
    }
    if (rows <= 0 || cols <= 0 || rows * cols > 1_000_000) {
      res.status(400).send("invalid size");
      return;
    }

    const initialPairs: AlivePairs = Array.isArray(alive) ? alive : [];
    // de-dup and bounds
    const validated  = new Set<string>();
    for (const p of initialPairs) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      const [r, c] = p;
      if (Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < rows && c >= 0 && c < cols) {
        validated.add(`${r},${c}`);
      }
    }
    const doc = await db.collection("boards").add({
      rows, cols,
      generation: 0,
      alive: docsFromSet(validated),   
      status: validated.size === 0 ? "extinct" : "active",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.status(201).json({ boardId: doc.id, generation: 0 });
  } catch (e) {
    console.error(e);
    res.status(500).send("create_failed");
  }
});

// GET /boards/:id
app.get("/boards/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const doc = await db.collection("boards").doc(req.params.id).get();
    if (!doc.exists) {
      res.status(404).send("not_found");
      return;
    }
    res.json({ id: doc.id, ...doc.data() });
  } catch (e) {
    console.error(e);
    res.status(500).send("fetch_failed");
  }
});

// GET /boards/:id/next?commit=true|false
app.get("/boards/:id/next", async (req: Request, res: Response): Promise<void> => {
  try {
    const commit = String(req.query.commit || "false") === "true";
    const ref = db.collection("boards").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).send("not_found");
      return;
    }
    const data = snap.data()!;
    const rows = data.rows as number;
    const cols = data.cols as number;
    const aliveSet = toSetFromDocs((data.alive as AliveDocs) ?? []);
    const next = nextGeneration(aliveSet, rows, cols);
    const generation = (data.generation as number) + 1;
    const status = next.size === 0 ? "extinct" : "active";

    if (commit) {
      await ref.update({
        alive: docsFromSet(next),
        generation,
        status,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    res.json({
      id: ref.id, rows, cols, generation, alive: pairsFromSet(next), status,
    });
  } catch (e) {
    console.error(e);
    res.status(500).send("next_failed");
  }
});

// GET /boards/:id/states?steps=N  (commits final state)
app.get("/boards/:id/states", async (req: Request, res: Response): Promise<void> => {
  try {
    const steps = parseInt(String(req.query.steps), 10);
    if (!Number.isFinite(steps) || steps < 1 || steps > 100000) {
      res.status(400).send("bad_steps");
      return;
    }
    const ref = db.collection("boards").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).send("not_found");
      return;
    }
    const data = snap.data()!;
    const rows = data.rows as number;
    const cols = data.cols as number;
    let generation = data.generation as number;
    let state = toSetFromDocs((data.alive as AliveDocs) ?? []);
    for (let i = 0; i < steps; i++) {
      state = nextGeneration(state, rows, cols);
      generation++;
      if (state.size === 0) break;
    }
    const status = state.size === 0 ? "extinct" : "active";
    await ref.update({
      alive: docsFromSet(state),
      generation,
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({
      id: ref.id, rows, cols, generation, alive: pairsFromSet(state), status,
    });
  } catch (e) {
    console.error(e);
    res.status(500).send("states_failed");
  }
});

// GET /boards/:id/final?maxAttempts=X  (commits result)
app.get("/boards/:id/final", async (req: Request, res: Response): Promise<void> => {
  try {
    const maxAttempts = parseInt(String(req.query.maxAttempts), 10);
    if (!Number.isFinite(maxAttempts) || maxAttempts < 1 || maxAttempts > 200000){
        res.status(400).send("bad_maxAttempts");
        return;
    }

    const ref = db.collection("boards").doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists){ res.status(404).send("not_found"); return}

    const data = snap.data()!;
    const rows = data.rows as number;
    const cols = data.cols as number;
    let generation = data.generation as number;
    let state = toSetFromDocs((data.alive as AliveDocs) ?? []);
    let status = data.status as string;

    for (let i = 0; i < maxAttempts; i++) {
      const prev = state;
      const next = nextGeneration(prev, rows, cols);
      generation++;
      if (next.size === 0) { state = next; status = "extinct"; break; }
      if (setsEqual(next, prev)) { state = next; status = "stable"; break; }
      state = next;
    }
    if (status !== "extinct" && status !== "stable") status = state.size === 0 ? "extinct" : "active";

    await ref.update({
      alive: docsFromSet(state),
      generation,
      status,
      updatedAt: FieldValue.serverTimestamp(),
    });
    res.json({ id: ref.id, rows, cols, generation, alive: pairsFromSet(state), status });
  } catch (e) {
    console.error(e);
    res.status(500).send("final_failed");
  }
});

// DELETE /boards/:id
app.delete("/boards/:id", async (req, res) => {
  try {
    await db.collection("boards").doc(req.params.id).delete();
    res.status(204).send();
  } catch (e) {
    console.error(e);
    res.status(500).send("delete_failed");
  }
});

// single HTTPS function exposing all routes
export const api = functions
  .runWith({ timeoutSeconds: 60, memory: "256MB" })
  .region("us-central1")
  .https.onRequest(app);
