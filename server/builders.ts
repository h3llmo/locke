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
export type NewJobExtra = Pick<NewJob, "scheduleId" | "keep" | "workflowRunId" | "editId"> & { summary?: Record<string, unknown> };
type Extra = NewJobExtra;
const links = (e: Extra) => ({ scheduleId: e.scheduleId, keep: e.keep, workflowRunId: e.workflowRunId, editId: e.editId });

/** Results come back as JPEG (quality 95, no metadata): much smaller than PNG for photos, and upscale needs it. */
export const RESULT_FORMAT = "jpeg";
const output = { format: RESULT_FORMAT };
/** Largest input accepted (pixels, and longest side): a 48 MP phone photo fits. The worker no longer shrinks inputs. */
export const MAX_INPUT_PIXELS = 50_000_000;
export const MAX_INPUT_SIDE = 10_000;

export function cleanImage(name: string, data: Buffer | undefined) {
  if (!data) throw err(400, "bad_request", `Missing file ${name}`);
  const format = detectFormat(data);
  if (!format) throw err(415, "unsupported_image", `${name}: use a PNG or JPEG image`);
  const size = imageSize(data, format);
  if (size && (size.width * size.height > MAX_INPUT_PIXELS || Math.max(size.width, size.height) > MAX_INPUT_SIDE)) {
    throw err(413, "image_too_large", `${name}: at most ${MAX_INPUT_PIXELS / 1e6} megapixels and ${MAX_INPUT_SIDE} pixels per side`);
  }
  return { data: stripMetadata(data, format), size };
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

/** What a worker must support to take each kind of job (also checked up front for every step of an edit). */
export const faceSwapRequirements = (chars: { gender: string; age: string; faces: number }[]) =>
  ({ characters: chars.map((c) => ({ gender: c.gender, age: c.age, faces: c.faces })), format: RESULT_FORMAT });
export const imageRequirements = (type: "enhance" | "blur", strength: string | number) =>
  ({ format: RESULT_FORMAT, ...(type === "enhance" ? { strength } : {}) });
export const upscaleRequirements = (scale: 2 | 4) => ({ scale, format: "jpeg" });

export async function faceSwapJob(ctx: Ctx, sub: string, target: Buffer, chars: CharacterInput[], extra: Extra = {}) {
  if (!chars.length || chars.some((c) => !c.faces.length)) throw err(400, "bad_request", "Each character needs at least one photo");
  const requirements = faceSwapRequirements(chars.map((c) => ({ gender: c.gender, age: c.age, faces: c.faces.length })));
  await assertSomeWorkerCan(ctx, "face_swap", requirements);
  const t = cleanImage("photo", target);
  if (!t.size) throw err(415, "unsupported_image", "photo: unreadable image size");
  const inputs = new Inputs();
  const image = inputs.add("photo", target);
  const characters = chars.map((c, i) => inputs.character(c, i));
  return createJob(ctx, {
    ownerSub: sub, type: "face_swap", inputs: inputs.list, requirements, maxResults: 1, resultSize: t.size,
    params: { image, match: "largest", characters, output },
    summary: { title: "Face swap", characters: chars.length, ...extra.summary },
    ...links(extra),
  });
}

export async function generateJob(ctx: Ctx, sub: string, p: GenerateSpec, refs: Buffer[], character: CharacterInput | null, extra: Extra = {}) {
  const requirements = { style: p.style, count: p.count, references: refs.length, character: !!character, format: RESULT_FORMAT };
  await assertSomeWorkerCan(ctx, "generate", requirements);
  const inputs = new Inputs();
  const references = refs.map((r, i) => inputs.add(`reference ${i + 1}`, r));
  const ch = character ? inputs.character(character, 0) : null;
  const params = {
    positive: p.positive, negative: p.negative, style: p.style, aspect: p.aspect, count: p.count, mode: p.mode,
    references, seed: p.seed, output,
    ...(ch ? { character: { ref: ch.ref, faces: ch.faces, mainFace: ch.mainFace } } : {}),
  };
  const title = p.positive.join(", ");
  return createJob(ctx, {
    ownerSub: sub, type: "generate", params, inputs: inputs.list, requirements, maxResults: p.count,
    summary: {
      title: title.length > 140 ? `${title.slice(0, 139)}…` : title, style: p.style, aspect: p.aspect, mode: p.mode, count: p.count,
      references: refs.length, positive: p.positive, negative: p.negative, ...extra.summary,
    },
    ...links(extra),
  });
}

/**
 * Enhance (spec §5.3: faces only, same size; fails with no_face_found when there is no face) and background blur
 * (§5.4): one image in, one result of the same size out.
 */
export async function imageJob(ctx: Ctx, sub: string, type: "enhance" | "blur", image: Buffer, strength: string | number, extra: Extra = {}) {
  const requirements = imageRequirements(type, strength);
  await assertSomeWorkerCan(ctx, type, requirements);
  const t = cleanImage("photo", image);
  const inputs = new Inputs();
  const id = inputs.add("photo", image);
  return createJob(ctx, {
    ownerSub: sub, type, inputs: inputs.list, requirements, maxResults: 1,
    resultSize: t.size,
    params: { image: id, strength, output },
    summary: { title: type === "blur" ? "Background blur" : "Enhance", ...extra.summary },
    ...links(extra),
  });
}

/** Most pixels an upscaled result may have (it must also fit the 25 MB result limit, hence JPEG). */
export const UPSCALE_MAX_PIXELS = 40_000_000;

/** Upscale (worker API §5.7): ×2 or ×4, reduced to stay within UPSCALE_MAX_PIXELS (never below the input). JPEG only. */
export async function upscaleJob(ctx: Ctx, sub: string, image: Buffer, scale: 2 | 4, extra: Extra = {}) {
  const requirements = upscaleRequirements(scale);
  await assertSomeWorkerCan(ctx, "upscale", requirements);
  cleanImage("photo", image);
  const inputs = new Inputs();
  const id = inputs.add("photo", image);
  return createJob(ctx, {
    ownerSub: sub, type: "upscale", inputs: inputs.list, requirements, maxResults: 1,
    params: { image: id, scale, maxPixels: UPSCALE_MAX_PIXELS, output: { format: "jpeg" } },
    summary: { title: `Upscale ×${scale}`, ...extra.summary },
    ...links(extra),
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
