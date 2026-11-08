import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, imageSize, metadataBlocks, stripMetadata, syntheticPng } from "./images.ts";
import { incompatibility, overlaps } from "./jobs.ts";

const pilot = {
  maxConcurrency: 1,
  faceSwap: { maxCharacters: 2, maxFacesPerCharacter: 8, genders: ["any", "woman", "man"], ages: ["any", "young", "adult", "senior"], ageAliases: { young: "adult" }, distinctFilters: true },
};
const req = (...c: [string, string][]) => ({ characters: c.map(([gender, age]) => ({ gender, age, faces: 1 })) });

test("routing follows the worker's capabilities", () => {
  assert.equal(incompatibility(pilot, "face_swap", req(["woman", "adult"])), null);
  assert.equal(incompatibility(pilot, "generate", req()), "type");
  assert.equal(incompatibility(pilot, "face_swap", req(["woman", "teen"])), "values");
  assert.equal(incompatibility(pilot, "face_swap", req(["woman", "adult"], ["man", "adult"], ["man", "senior"])), "values");
  assert.equal(incompatibility(pilot, "face_swap", req(["woman", "adult"], ["man", "senior"])), null);
  assert.equal(incompatibility(pilot, "face_swap", req(["woman", "young"], ["woman", "adult"])), "overlap"); // young = adult here
  assert.equal(incompatibility(pilot, "face_swap", req(["any", "senior"], ["man", "senior"])), "overlap");
  assert.equal(incompatibility(null, "face_swap", req(["woman", "adult"])), "type");
});

test("overlap rules", () => {
  assert.equal(overlaps({ gender: "woman", age: "adult" }, { gender: "man", age: "adult" }), false);
  assert.equal(overlaps({ gender: "woman", age: "any" }, { gender: "woman", age: "senior" }), true);
  assert.equal(overlaps({ gender: "woman", age: "young" }, { gender: "woman", age: "adult" }), false);
});

test("synthetic PNG is valid and metadata-free", () => {
  const png = syntheticPng(64, 48, 1);
  assert.equal(detectFormat(png), "png");
  assert.deepEqual(metadataBlocks(png, "png"), []);
});

test("metadata is stripped, JPEG orientation kept", () => {
  // PNG with a tEXt chunk (as Fooocus writes the prompt) inserted after IHDR.
  const png = syntheticPng(8, 8, 1);
  const text = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("tEXtprompt\0hello", "latin1").subarray(0, 15), Buffer.alloc(4)]);
  const withText = Buffer.concat([png.subarray(0, 33), text, png.subarray(33)]);
  assert.deepEqual(metadataBlocks(withText, "png"), ["tEXt"]);
  assert.deepEqual(stripMetadata(withText, "png"), png);

  // JPEG: SOI, APP1 EXIF (orientation 6 + a GPS-ish dummy entry), COM, then SOS + data.
  const tiff = Buffer.alloc(8 + 2 + 24 + 4);
  tiff.write("II", 0, "latin1"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  tiff.writeUInt16LE(0x8825, 22); tiff.writeUInt16LE(4, 24); tiff.writeUInt32LE(1, 26); tiff.writeUInt32LE(0, 30);
  const app1Payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const seg = (marker: number, payload: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16BE(0xff00 | marker); h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe1, app1Payload), seg(0xfe, Buffer.from("secret comment")), Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])]);
  assert.equal(detectFormat(jpeg), "jpeg");
  const clean = stripMetadata(jpeg, "jpeg");
  assert.ok(!clean.includes(Buffer.from("secret comment")));
  assert.ok(!clean.includes(Buffer.from([0x25, 0x88])), "GPS pointer gone");
  assert.ok(clean.includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06])), "orientation 6 kept");
  assert.ok(clean.subarray(-9).equals(Buffer.from([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9])));
});

test("generate routing: style, count, format and character support", () => {
  const caps = { resultFormats: ["png"], generate: { styles: [{ id: "photo-neutre" }], counts: [1, 2, 3, 4], character: false } };
  const g = (o: Record<string, unknown> = {}) => ({ style: "photo-neutre", count: 1, references: 0, character: false, format: "png", ...o });
  assert.equal(incompatibility(caps, "generate", g()), null);
  assert.equal(incompatibility(caps, "generate", g({ style: "nope" })), "values");
  assert.equal(incompatibility(caps, "generate", g({ count: 5 })), "values");
  assert.equal(incompatibility(caps, "generate", g({ format: "jpeg" })), "values");
  assert.equal(incompatibility(caps, "generate", g({ character: true })), "values");
  assert.equal(incompatibility(caps, "generate", g({ references: 5 })), "values");
  assert.equal(incompatibility(caps, "generate", { raw: true }), null, "raw admin tests go to the worker as written");
  assert.equal(incompatibility(caps, "face_swap", { raw: true }), "type");
});

test("image size from PNG and JPEG headers", () => {
  assert.deepEqual(imageSize(syntheticPng(64, 48, 1), "png"), { width: 64, height: 48 });
  // Minimal JPEG: SOI, APP0 (JFIF), SOF0 for 300×200, SOS.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 8, 0x00, 200, 0x01, 0x2c, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xda, 0x00, 0x02])]);
  assert.deepEqual(imageSize(jpeg, "jpeg"), { width: 300, height: 200 });
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), "jpeg"), null);
});
