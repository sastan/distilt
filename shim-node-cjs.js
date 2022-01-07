import { pathToFileURL } from 'url'
import { createRequire } from 'module'

export const shim_import_meta_url = /*#__PURE__*/ pathToFileURL(__filename)
export const shim_import_meta_resolve = async (specifier, parent) => {
  const { resolve } = parent ? createRequire(parent) : require
  return resolve(specifier)
}
