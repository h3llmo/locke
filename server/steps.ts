import { z } from "zod";
import { assertSomeWorkerCan, err, type Ctx } from "./jobs.ts";
import {
  faceSwapJob, faceSwapRequirements, imageJob, imageRequirements, upscaleJob, upscaleRequirements, type NewJobExtra,
} from "./builders.ts";
import { characterStore } from "./characters.ts";

/**
 * Steps on one photo, shared by edits (Editor) and workflows (Automate): face swap, enhance, upscale and background
 * blur, in any order the user chooses. Each step is one GPU job whose result feeds the next.
 */
export const STRENGTHS = ["subtle", "balanced", "strong"] as const;
export const MAX_STEPS = 6;

export const stepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("face_swap"), characters: z.array(z.string().max(64)).min(1).max(4) }),
  z.object({ op: z.literal("enhance"), strength: z.enum(STRENGTHS).default("balanced") }),
  z.object({ op: z.literal("upscale"), scale: z.union([z.literal(2), z.literal(4)]).default(2) }),
  z.object({ op: z.literal("blur"), strength: z.number().int().min(0).max(100).default(60) }),
]);
export type Step = z.infer<typeof stepSchema>;

export const STEP_TITLES: Record<Step["op"], string> = { face_swap: "Face swap", enhance: "Enhance", upscale: "Upscale", blur: "Blur" };
export const stepTitle = (s: Step) =>
  s.op === "upscale" ? `Upscale ×${s.scale}` : s.op === "blur" ? `Blur ${s.strength}` : s.op === "enhance" ? `Enhance (${s.strength})` : STEP_TITLES[s.op];

/** No face to swap or enhance: the step is skipped and the image goes on unchanged. */
export const skippable = (s: Step, failure: string | null) => failure === "no_face_found" && (s.op === "face_swap" || s.op === "enhance");

/**
 * Refuses up front, with a message the user can act on, a chain no live worker can run: every step is checked, so an
 * edit never stops halfway because its third step was never possible. Characters must exist and have photos.
 */
export async function checkSteps(ctx: Ctx, sub: string, steps: Step[]) {
  const chars = characterStore(ctx);
  for (const s of steps) {
    if (s.op === "face_swap") {
      if (new Set(s.characters).size !== s.characters.length) throw err(400, "bad_request", "A character is listed twice");
      const views = [];
      for (const id of s.characters) {
        const v = chars.view(await chars.get(sub, id));
        if (!v.faces.length) throw err(422, "character_without_photos", `${v.name} has no photos yet`);
        views.push({ gender: v.gender, age: v.age, faces: v.faces.length });
      }
      await assertSomeWorkerCan(ctx, "face_swap", faceSwapRequirements(views));
    } else if (s.op === "upscale") {
      await assertSomeWorkerCan(ctx, "upscale", upscaleRequirements(s.scale));
    } else {
      await assertSomeWorkerCan(ctx, s.op, imageRequirements(s.op, s.strength));
    }
  }
}

/** Queues the GPU job for one step on `image`. */
export async function startStep(ctx: Ctx, sub: string, step: Step, image: Buffer, extra: NewJobExtra): Promise<string> {
  if (step.op === "face_swap") {
    const chars = characterStore(ctx);
    const cs = [];
    for (const id of step.characters) cs.push(await chars.load(sub, id));
    return faceSwapJob(ctx, sub, image, cs, extra);
  }
  if (step.op === "upscale") return upscaleJob(ctx, sub, image, step.scale, extra);
  return imageJob(ctx, sub, step.op, image, step.strength, extra);
}
