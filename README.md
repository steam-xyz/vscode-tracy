# VS Code Tracy

Use the upstream Tracy wasm UI inside VS Code.

## Current scope

- Open saved `.tracy` files from the explorer context menu, editor context menu, or command palette.
- Run the Tracy UI from a local HTTP server exposed through `vscode.env.asExternalUri`, so the same flow works for local workspaces and Remote-SSH.
- Reuse the latest wasm build published at `https://tracy.nereid.pl/`.

## Development

Fetch `tracy-ui`

```sh
pnpm tracy:fetch
```

Compile

```sh
pnpm install
pnpm compile
pnpm run package:vsix
```

Press `F5` in VS Code to launch an extension development host.

## Notes

- This extension intentionally does not build Tracy from source yet.
- The upstream wasm build disables live socket connections, so the current extension focuses on opening saved trace files.
