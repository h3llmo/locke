import { assertSomeWorkerCan, createJob, err, newId, type Ctx, type NewJob } from "./jobs.ts";
import { detectFormat, imageSize, stripMetadata } from "./images.ts";

/**
 * Building jobs from images in memory, shared by the user API, schedules and workflows. Images are checked
 * (PNG or JPEG), stripped of metadata and sealed by createJob.
 */
export interface CharacterInput { gender: string; age: string; faces: Buffer[] } // faces[0] = main face
export interface GenerateSpec {
  positive: string[]; negative: string[]; style: string; aspect: "square" | "portrait" | "landscape";
  count: number; mode: "fast" | "quality"; seed: number | null;
}
type Extra = Pick<NewJob, "scheduleId" | "keep" | "workflowRunId"> & { summary?: Record<string, unknown> };

export function cleanImage(name: string, data: Buffer | undefined) {
  if (!data) throw err(400, "bad_request", `Missing file ${name}`);
  const format = detectFormat(data);
  if (!format) throw err(415, "unsupported_image", `${name}: use a PNG or JPEG image`);
  return { data: stripMetadata(data, format), size: imageSize(data, format) };
}

class Inputs {
  list: { id: string; data: Buffer }[] = [];
  add(name: string, data: Buffer) {
    const id = newId("in");
    this.list.push({ id, data: cleanImage(name, data).data });
    return id;
  }
  character(c: CharacterInput, i: number) {
    const faces = c.faces.map((f, j) => this.add(`character ${i + 1} photo ${j + 1}`, f));
    return { ref: `ch_${i + 1}`, faces, mainFace: faces[0]!, gender: c.gender, age: c.age };
  }
}

export async function faceSwapJob(ctx: Ctx, sub: string, target: Buffer, chars: CharacterInput[], extra: Extra = {}) {
  if (!chars.length || chars.some((c) => !c.faces.length)) throw err(400, "bad_request", "Each character needs at least one photo");
  const requirements = { characters: chars.map((c) => ({ gender: c.gender, age: c.age, faces: c.faces.length })), format: "png" };
  await assertSomeWorkerCan(ctx, "face_swap", requirements);
  const t = cleanImage("photo", target);
  if (!t.size) throw err(415, "unsupported_image", "photo: unreadable image size");
  const inputs = new Inputs();
  const image = inputs.add("photo", target);
  const characters = chars.map((c, i) => inputs.character(c, i));
  return createJob(ctx, {
    ownerSub: sub, type: "face_swap", inputs: inputs.list, requirements, maxResults: 1, resultSize: t.size,
    params: { image, match: "largest", characters, output: { format: "png" } },
    summary: { title: "Face swap", characters: chars.length, ...extra.summary },
    scheduleId: extra.scheduleId, keep: extra.keep, workflowRunId: extra.workflowRunId,
  });
}

export async function generateJob(ctx: Ctx, sub: string, p: GenerateSpec, refs: Buffer[], character: CharacterInput | null, extra: Extra = {}) {
  const requirements = { style: p.style, count: p.count, references: refs.length, character: !!character, format: "png" };
  await assertSomeWorkerCan(ctx, "generate", requirements);
  const inputs = new Inputs();
  const references = refs.map((r, i) => inputs.add(`reference ${i + 1}`, r));
  const ch = character ? inputs.character(character, 0) : null;
  const params = {
    positive: p.positive, negative: p.negative, style: p.style, aspect: p.aspect, count: p.count, mode: p.mode,
    references, seed: p.seed, output: { format: "png" },
    ...(ch ? { character: { ref: ch.ref, faces: ch.faces, mainFace: ch.mainFace } } : {}),
  };
  const title = p.positive.join(", ");
  return createJob(ctx, {
    ownerSub: sub, type: "generate", params, inputs: inputs.list, requirements, maxResults: p.count,
    summary: {
      title: title.length > 140 ? `${title.slice(0, 139)}…` : title, style: p.style, aspect: p.aspect, mode: p.mode, count: p.count,
      references: refs.length, positive: p.positive, negative: p.negative, ...extra.summary,
    },
    scheduleId: extra.scheduleId, keep: extra.keep, workflowRunId: extra.workflowRunId,
  });
}

/** Enhance and background blur (spec §5.3, §5.4, drafts): one image in, one result out. */
export async function imageJob(ctx: Ctx, sub: string, type: "enhance" | "blur", image: Buffer, strength: string | number, extra: Extra = {}) {
  const requirements = { format: "png" };
  await assertSomeWorkerCan(ctx, type, requirements);
  const t = cleanImage("photo", image);
  const inputs = new Inputs();
  const id = inputs.add("photo", image);
  return createJob(ctx, {
    ownerSub: sub, type, inputs: inputs.list, requirements, maxResults: 1,
    resultSize: type === "blur" ? t.size : null,
    params: { image: id, strength, output: { format: "png" } },
    summary: { title: type === "blur" ? "Background blur" : "Enhance", ...extra.summary },
    scheduleId: extra.scheduleId, keep: extra.keep, workflowRunId: extra.workflowRunId,
  });
}

/** Most pixels an upscaled result may have (it must also fit the 25 MB result limit, hence JPEG). */
export const UPSCALE_MAX_PIXELS = 40_000_000;

/** Upscale (draft, worker API §5.7): ×2 or ×4, reduced to stay within UPSCALE_MAX_PIXELS. */
export async function upscaleJob(ctx: Ctx, sub: string, image: Buffer, scale: 2 | 4, extra: Extra = {}) {
  const requirements = { scale, format: "jpeg" };
  await assertSomeWorkerCan(ctx, "upscale", requirements);
  cleanImage("photo", image);
  const inputs = new Inputs();
  const id = inputs.add("photo", image);
  return createJob(ctx, {
    ownerSub: sub, type: "upscale", inputs: inputs.list, requirements, maxResults: 1,
    params: { image: id, scale, maxPixels: UPSCALE_MAX_PIXELS, output: { format: "jpeg" } },
    summary: { title: `Upscale ×${scale}`, ...extra.summary },
    scheduleId: extra.scheduleId, keep: extra.keep, workflowRunId: extra.workflowRunId,
  });
}

/** Multipart body: a `params` JSON field and image files by field name. */
export async function readMultipart(req: import("fastify").FastifyRequest): Promise<{ params: unknown; files: Map<string, Buffer> }> {
  if (!req.isMultipart()) throw err(415, "multipart_required", "Send this as multipart/form-data");
  let text: string | undefined;
  const files = new Map<string, Buffer>();
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (files.has(part.fieldname)) throw err(400, "bad_request", `Duplicate file ${part.fieldname}`);
      files.set(part.fieldname, await part.toBuffer());
    } else if (part.fieldname === "params") {
      text = String(part.value);
    }
  }
  if (!text) throw err(400, "bad_request", "Missing params");
  try { return { params: JSON.parse(text), files }; } catch { throw err(400, "bad_request", "params is not JSON"); }
}
