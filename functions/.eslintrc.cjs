module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*", // Ignore built files.
    "/generated/**/*", // Ignore generated files.
  ],
  plugins: [
    "@typescript-eslint",
    "import",
  ],
  rules: {
    "quotes": ["error", "double"],
    "import/no-unresolved": 0,
    "indent": "off",
    "object-curly-spacing": "off",
    "no-multi-spaces": "off",
    "max-len": "off",
    "require-jsdoc": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "arrow-parens": "off",
    "no-trailing-spaces": "off",
    "space-before-blocks": "off",
    "brace-style": "off",
    "block-spacing": "off",
    "semi": "off",
  },
};
