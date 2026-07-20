// backend/src/types/optional-modules.d.ts
//
// Type shims for OPTIONAL native dependencies that may not be installed in
// every environment (e.g. @osrm/osrm requires a C++ toolchain to build).
// The code that uses them does so via dynamic `import()` and treats them as
// `any`, so a missing/broken native build never breaks `tsc`, `npm install`,
// or the server boot.

declare module '@osrm/osrm' {
  const Osrm: any;
  export default Osrm;
  export = Osrm;
}
