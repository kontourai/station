/** Generated validator interface; implementation is reproducibly generated from vendored schemas. */
export interface SchemaValidator {
  (value: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
}
export const validateManifest: SchemaValidator;
export const validateStationExtension: SchemaValidator;
