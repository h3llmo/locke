import { test } from "node:test";
import assert from "node:assert/strict";
import { detectFormat, metadataBlocks, stripMetadata, syntheticPng } from "./images.ts";
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
