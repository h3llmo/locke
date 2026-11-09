import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AGES, err, GENDERS, newId, type Ctx } from "./jobs.ts";
import { cleanImage, type CharacterInput } from "./builders.ts";
import { contentType, detectFormat } from "./images.ts";
import { newBlobKey, openRow, RowBlobs, sealRow } from "./sealed.ts";

/**
 * Saved characters (HANDOFF §5.5): a name, a gender and an age (which face in a photo is theirs) and 1–8 face photos,
 * the first being the main face. Reused by face swap, generate (when the GPU supports it) and workflows.
 * Name, gender and age are sealed; photos are sealed blobs (metadata stripped).
 */
export const MAX_FACES = 8;
export const MAX_CHARACTERS_PER_USER = 100;
const dataSchema = z.object({
  name: z.string().trim().min(1).max(60),
  gender: z.enum(GENDERS).default("any"),
  age: z.enum(AGES).default("any"),
});
type Data = z.infer<typeof dataSchema>;
interface Face { id: string; bytes: number; format: string }
interface Row { id: string; owner_sub: string; data: string; blob_key: string; faces: Face[]; created_at: Date; updated_at: Date }

export function characterStore(ctx: Ctx) {
  const blobs = new RowBlobs(ctx.store, ctx.sealer, "characters");
  const get = async (sub: string, id: string): Promise<Row> => {
    const { rows } = await ctx.db.query<Row>("SELECT * FROM characters WHERE id = $1 AND owner_sub = $2", [id, sub]);
    if (!rows[0]) throw err(404, "character_not_found", "Character not found");
    return rows[0];
  };
  const view = (r: Row) => {
    const d = openRow<Data>(ctx.sealer, r.id, r.data);
    return { id: r.id, name: d.name, gender: d.gender, age: d.age, faces: r.faces.map((f) => ({ id: f.id })), createdAt: r.created_at, updatedAt: r.updated_at };
  };
  /** A character's settings and photos, ready for a job (main face first). */
  const load = async (sub: string, id: string): Promise<CharacterInput & { name: string }> => {
    const r = await get(sub, id);
    const d = openRow<Data>(ctx.sealer, r.id, r.data);
    const faces: Buffer[] = [];
    for (const f of r.faces) {
      const b = await blobs.get(r.id, r.blob_key, f.id);
      if (b) faces.push(b);
    }
    if (!faces.length) throw err(422, "character_without_photos", `${d.name} has no photos yet`);
    return { name: d.name, gender: d.gender, age: d.age, faces };
  };
  return { blobs, get, view, load };
}

export type Auth = (req: FastifyRequest) => Promise<{ sub: string }>;

export function registerCharacterApi(app: FastifyInstance, ctx: Ctx, prefix: string, auth: Auth) {
  const cs = characterStore(ctx);
  const idOf = (p: unknown) => z.object({ id: z.string().max(64) }).parse(p).id;

  app.get(`${prefix}/characters`, async (req) => {
    const c = await auth(req);
    const { rows } = await ctx.db.query<Row>("SELECT * FROM characters WHERE owner_sub = $1 ORDER BY created_at", [c.sub]);
    return { characters: rows.map(cs.view) };
  });

  app.post(`${prefix}/characters`, async (req, reply) => {
    const c = await auth(req);
    const d = dataSchema.parse(req.body);
    const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM characters WHERE owner_sub = $1", [c.sub]);
    if (rows[0]!.n >= MAX_CHARACTERS_PER_USER) throw err(409, "too_many", `At most ${MAX_CHARACTERS_PER_USER} characters`);
    const id = newId("chr");
    await ctx.db.query("INSERT INTO characters (id, owner_sub, data, blob_key) VALUES ($1, $2, $3, $4)", [id, c.sub, sealRow(ctx.sealer, id, d), newBlobKey(ctx.sealer)]);
    return reply.status(201).send(cs.view(await cs.get(c.sub, id)));
  });

  // Rename, change gender/age, reorder photos (the first is the main face).
  app.patch(`${prefix}/characters/:id`, async (req) => {
    const c = await auth(req);
    const r = await cs.get(c.sub, idOf(req.params));
    // No defaults here: a field left out keeps its value.
    const b = z.object({
      name: z.string().trim().min(1).max(60).optional(),
      gender: z.enum(GENDERS).optional(),
      age: z.enum(AGES).optional(),
      faceOrder: z.array(z.string().max(64)).max(MAX_FACES).optional(),
    }).parse(req.body);
    const cur = openRow<Data>(ctx.sealer, r.id, r.data);
    const next: Data = { name: b.name ?? cur.name, gender: b.gender ?? cur.gender, age: b.age ?? cur.age };
    let faces = r.faces;
    if (b.faceOrder) {
      const byId = new Map(r.faces.map((f) => [f.id, f]));
      if (b.faceOrder.length !== r.faces.length || b.faceOrder.some((f) => !byId.has(f))) throw err(400, "bad_request", "faceOrder must list every photo once");
      faces = b.faceOrder.map((f) => byId.get(f)!);
    }
    await ctx.db.query("UPDATE characters SET data = $2, faces = $3, updated_at = now() WHERE id = $1", [r.id, sealRow(ctx.sealer, r.id, next), JSON.stringify(faces)]);
    return cs.view(await cs.get(c.sub, r.id));
  });

  app.delete(`${prefix}/characters/:id`, async (req, reply) => {
    const c = await auth(req);
    const r = await cs.get(c.sub, idOf(req.params));
    await ctx.db.query("DELETE FROM characters WHERE id = $1", [r.id]);
    await cs.blobs.deleteRow(r.id).catch(() => {});
    return reply.status(204).send();
  });

  // One photo per request, raw body (Content-Type image/png or image/jpeg). Added last (the first stays the main face).
  app.post(`${prefix}/characters/:id/faces`, async (req, reply) => {
    const c = await auth(req);
    const r = await cs.get(c.sub, idOf(req.params));
    if (!Buffer.isBuffer(req.body)) throw err(415, "unsupported_image", "Send the photo as the raw body (Content-Type: image/png or image/jpeg)");
    if (r.faces.length >= MAX_FACES) throw err(409, "too_many", `At most ${MAX_FACES} photos per character`);
    const img = cleanImage("photo", req.body);
    const face: Face = { id: newId("fc"), bytes: 0, format: detectFormat(img.data)! };
    face.bytes = await cs.blobs.put(r.id, r.blob_key, face.id, img.data);
    // Appended atomically; a concurrent upload beyond the limit is removed again.
    const { rows } = await ctx.db.query<{ n: number }>(
      "UPDATE characters SET faces = faces || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING jsonb_array_length(faces) AS n",
      [r.id, JSON.stringify([face])],
    );
    if (rows[0]!.n > MAX_FACES) {
      await ctx.db.query("UPDATE characters SET faces = (SELECT jsonb_agg(f) FROM jsonb_array_elements(faces) f WHERE f->>'id' <> $2) WHERE id = $1", [r.id, face.id]);
      await cs.blobs.delete(r.id, face.id).catch(() => {});
      throw err(409, "too_many", `At most ${MAX_FACES} photos per character`);
    }
    return reply.status(201).send(cs.view(await cs.get(c.sub, r.id)));
  });

  app.delete(`${prefix}/characters/:id/faces/:face`, async (req) => {
    const c = await auth(req);
    const { face } = z.object({ face: z.string().max(64) }).parse(req.params);
    const r = await cs.get(c.sub, idOf(req.params));
    if (!r.faces.some((f) => f.id === face)) throw err(404, "not_found", "Photo not found");
    await ctx.db.query("UPDATE characters SET faces = $2, updated_at = now() WHERE id = $1", [r.id, JSON.stringify(r.faces.filter((f) => f.id !== face))]);
    await cs.blobs.delete(r.id, face).catch(() => {});
    return cs.view(await cs.get(c.sub, r.id));
  });

  app.get(`${prefix}/characters/:id/faces/:face`, async (req, reply) => {
    const c = await auth(req);
    const { face } = z.object({ face: z.string().max(64) }).parse(req.params);
    const r = await cs.get(c.sub, idOf(req.params));
    const f = r.faces.find((x) => x.id === face);
    const data = f && (await cs.blobs.get(r.id, r.blob_key, f.id));
    if (!f || !data) throw err(404, "not_found", "Photo not found");
    return reply.header("content-type", contentType(f.format as "png" | "jpeg")).header("cache-control", "private, max-age=3600").send(data);
  });
}
