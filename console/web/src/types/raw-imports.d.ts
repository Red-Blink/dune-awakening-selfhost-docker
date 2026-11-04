// Vite's `?raw` suffix imports a file's contents as a string. Used by
// ServerPanels.heroFloor.property.test.ts to read the summariser's source and
// assert that its enumeration still matches reality -- the project has no
// @types/node, so node:fs is not an option here.
declare module "*?raw" {
  const content: string;
  export default content;
}
