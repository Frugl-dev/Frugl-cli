import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir as osHomedir } from "node:os";
import { join } from "node:path";
import { defaultIO } from "./io.js";

// io.ts is the real-filesystem implementation of the injectable CaptureIO
// boundary. Exercise it against actual temp dirs so the read/parse/tolerance
// behavior is verified, not stubbed.
describe("defaultIO", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "frugl-io-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("readFile", () => {
    it("returns the file contents as utf8", async () => {
      const path = join(dir, "note.txt");
      await writeFile(path, "hello frugl");
      expect(defaultIO.readFile(path)).toBe("hello frugl");
    });

    it("throws when the file is missing (no silent fallback)", () => {
      expect(() => defaultIO.readFile(join(dir, "nope.txt"))).toThrow(/ENOENT/);
    });
  });

  describe("readDir", () => {
    it("lists entry names for an existing directory", async () => {
      await writeFile(join(dir, "a.txt"), "");
      await mkdir(join(dir, "sub"));
      expect(defaultIO.readDir(dir).toSorted()).toEqual(["a.txt", "sub"]);
    });

    it("returns [] for a missing directory instead of throwing", () => {
      expect(defaultIO.readDir(join(dir, "missing"))).toEqual([]);
    });

    it("returns [] when the path is a file, not a directory", async () => {
      const file = join(dir, "f.txt");
      await writeFile(file, "x");
      expect(defaultIO.readDir(file)).toEqual([]);
    });
  });

  describe("isDir", () => {
    it("is true for a directory", () => {
      expect(defaultIO.isDir(dir)).toBe(true);
    });

    it("is false for a regular file", async () => {
      const file = join(dir, "f.txt");
      await writeFile(file, "x");
      expect(defaultIO.isDir(file)).toBe(false);
    });

    it("is false for a missing path", () => {
      expect(defaultIO.isDir(join(dir, "missing"))).toBe(false);
    });
  });

  describe("run", () => {
    it("captures stdout and status 0 on success", () => {
      const res = defaultIO.run("node", ["-e", "process.stdout.write('ok')"]);
      expect(res.stdout).toBe("ok");
      expect(res.status).toBe(0);
    });

    it("returns the non-zero status of a failing process", () => {
      const res = defaultIO.run("node", ["-e", "process.exit(3)"]);
      expect(res.status).toBe(3);
    });

    it("returns status 1 and empty stdout when the binary cannot be spawned", () => {
      const res = defaultIO.run("frugl-nonexistent-binary-xyz", []);
      expect(res.stdout).toBe("");
      expect(res.status).not.toBe(0);
    });
  });

  describe("environment passthroughs", () => {
    it("homedir matches os.homedir", () => {
      expect(defaultIO.homedir()).toBe(osHomedir());
    });

    it("cwd matches process.cwd", () => {
      expect(defaultIO.cwd()).toBe(process.cwd());
    });

    it("join composes path segments", () => {
      expect(defaultIO.join("a", "b", "c")).toBe(join("a", "b", "c"));
    });
  });
});
