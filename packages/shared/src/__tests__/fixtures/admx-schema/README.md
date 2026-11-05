# ADMX schema (test fixture)

These three files are the ADMX schema from Microsoft's open specification
[MS-GPREG] "Group Policy: Registry Extension Encoding", section 7:

- `BaseTypes.xsd`: [§7.1](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gpreg/81d92810-a6d2-4301-a607-b3ba34dc2989)
- `PolicyDefinitions.xsd`: [§7.2](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gpreg/81a89003-5121-4216-b788-fde8daa71c78)
- `PolicyDefinitionFiles.xsd`: [§7.3](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gpreg/ddeb37b6-22ab-4936-adc4-b9d7fe1de6e6)

The Open Specifications terms allow copies for building and documenting an
implementation. `packages/shared/src/__tests__/managed-policy-templates.test.ts`
validates the generated `station.admx` and `en-US/station.adml` against them
with `xmllint`.

Two changes from the published text, both required to validate real files:

1. The published `targetNamespace` is `http://www.microsoft.com/GroupPolicy/PolicyDefinitions`.
   Every ADMX file Windows ships, and the files the Group Policy editor loads, use
   `http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions`. The
   files here use the second namespace.
2. `BaseTypes.xsd` escapes the dollar sign as `\$` in two patterns. XML Schema
   regular expressions have no `\$` escape, and libxml2 refuses the pattern.
   The patterns here write it as `[$]`, which matches the same text.

Line breaks and indentation were normalized with `xmllint --format`.
