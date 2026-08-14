# Trellis renderer

Trellis is a read-only renderer in Git UI Pro.

The desktop bridge and Trellis domain remain independent from the renderer. The UI is mounted into the empty worktree editor canvas by `TrellisCanvasPortal`; opening a file removes the empty canvas and the normal diff/file preview takes over.

The Trellis UI must use Git UI Pro theme tokens from `app.css` rather than its own light/dark palette.
