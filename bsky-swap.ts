#!/usr/bin/env -S deno run --allow-write --allow-read --allow-sys

import fs from "node:fs";
import os from 'node:os'
import path from 'node:path'

const configFile =
  (os.type() == 'Windows_NT')
  ? path.join(os.homedir(), "AppData", "Roaming", ".bsky-cli.json")
  : path.join(os.homedir(), ".bsky-cli")
const altFile =
  (os.type() == 'Windows_NT')
  ? path.join(os.homedir(), "AppData", "Roaming", ".bsky-cli.alt.json")
  : path.join(os.homedir(), ".bsky-cli.alt")
const tempFile =
  (os.type() == 'Windows_NT')
  ? path.join(os.homedir(), "AppData", "Roaming", ".bsky-cli.tmp.json")
  : path.join(os.homedir(), ".bsky-cli.tmp")

const configExists = fs.existsSync(configFile)
const altExists = fs.existsSync(altFile)

if (configExists && altExists) {
  fs.renameSync(configFile, tempFile)
  fs.renameSync(altFile, configFile)
  fs.renameSync(tempFile, altFile)
} else if (configExists) {
  fs.renameSync(configFile, altFile)
} else if (altExists) {
  fs.renameSync(altFile, configFile)
} else {
  console.log()
}
