#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from "fs/promises"
import { existsSync } from "fs"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { execFileSync } from "child_process"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const SOURCE_EXTENSION_DIR = join(__dirname, "extension")
const OUTPUT_ROOT_DIR = join(__dirname, "artifacts", "chrome-web-store")
const STAGING_DIR = join(OUTPUT_ROOT_DIR, "extension")

const OPTIONAL_PERMISSIONS = new Set(["nativeMessaging", "downloads", "debugger"])

function sortUnique(values) {
  return [...new Set(values)].sort()
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

async function writeJson(filePath, data) {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8")
}

function transformManifestForChromeWebStore(manifest) {
  const next = structuredClone(manifest)

  delete next.key

  const permissions = Array.isArray(next.permissions) ? next.permissions : []
  const optionalPermissions = new Set(Array.isArray(next.optional_permissions) ? next.optional_permissions : [])

  const requiredPermissions = []
  for (const permission of permissions) {
    if (permission === "notifications") continue
    if (OPTIONAL_PERMISSIONS.has(permission)) {
      optionalPermissions.add(permission)
      continue
    }
    requiredPermissions.push(permission)
  }

  next.permissions = sortUnique(requiredPermissions)

  if (optionalPermissions.size) {
    next.optional_permissions = sortUnique([...optionalPermissions])
  } else {
    delete next.optional_permissions
  }

  const optionalOrigins = new Set(Array.isArray(next.optional_host_permissions) ? next.optional_host_permissions : [])
  const hostPermissions = Array.isArray(next.host_permissions) ? next.host_permissions : []
  for (const origin of hostPermissions) {
    optionalOrigins.add(origin)
  }

  delete next.host_permissions

  if (optionalOrigins.size) {
    next.optional_host_permissions = sortUnique([...optionalOrigins])
  } else {
    delete next.optional_host_permissions
  }

  return next
}

function buildZip(stagingDir, outputZipPath) {
  const zipBinary = "zip"
  execFileSync(zipBinary, ["-qr", outputZipPath, "."], { cwd: stagingDir, stdio: "inherit" })
}

async function main() {
  if (!existsSync(SOURCE_EXTENSION_DIR)) {
    throw new Error(`Missing extension directory: ${SOURCE_EXTENSION_DIR}`)
  }

  await mkdir(OUTPUT_ROOT_DIR, { recursive: true })
  await rm(STAGING_DIR, { recursive: true, force: true })
  await cp(SOURCE_EXTENSION_DIR, STAGING_DIR, { recursive: true })

  const manifestPath = join(STAGING_DIR, "manifest.json")
  const manifest = await readJson(manifestPath)
  const transformedManifest = transformManifestForChromeWebStore(manifest)
  await writeJson(manifestPath, transformedManifest)

  const version = transformedManifest.version || "0.0.0"
  const zipPath = resolve(join(OUTPUT_ROOT_DIR, `opencode-browser-cws-v${version}.zip`))
  await rm(zipPath, { force: true })
  buildZip(STAGING_DIR, zipPath)

  const metadataPath = join(OUTPUT_ROOT_DIR, "manifest.chrome-web-store.json")
  await writeJson(metadataPath, transformedManifest)

  console.log("\nChrome Web Store package ready:")
  console.log(`- Zip: ${zipPath}`)
  console.log(`- Staging: ${STAGING_DIR}`)
  console.log(`- Store manifest: ${metadataPath}`)
}

main().catch((error) => {
  console.error(`Failed to build Chrome Web Store package: ${error?.message || String(error)}`)
  process.exit(1)
})
