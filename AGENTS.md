# Repository Instructions

## Fixed submission paths

These repository-relative paths are stable submission contracts:

- Video: `artifacts/agent-forge-feature-package/delivery/agent-forge-feature-demo.mp4`
- Presentation: `artifacts/agent-forge-feature-package/delivery/agent-forge-demo.pptx`
- Thumbnail: `artifacts/agent-forge-feature-package/delivery/agent-forge-thumbnail.png`
- Manifest: `artifacts/agent-forge-feature-package/delivery/manifest.json`
- Package archive: `artifacts/agent-forge-feature-package/agent-forge-demo-package.zip`

Never delete, rename, move, or clean the canonical submission directory or these files. Submission tooling depends on the exact video path. A new version must be built and verified outside `delivery/`, then replace the canonical file at the same path.

## Demonstration-video contract

The submitted video is a product demonstration, not a test report.

- Show a real PowerShell window using the real CLI and filesystem.
- Use the real OpenAI Codex OAuth connection; do not submit mocked-SSE footage.
- Do not show Vitest, `test.ts`, E2E/PASS banners, or production notes.
- Show a natural request-and-response rhythm: user request, Agent tool call, Agent reply, then a PowerShell check of the real output.
- Demonstrate file reading, creation, editing, shell execution, and one composite tool request.
- After write/edit/bash operations, confirm the actual result with `Get-Content`, `type`, or an equivalent read-only command.
- Keep authentication secrets out of recordings. Never show passwords, OTPs, access tokens, refresh tokens, or recovery codes.
- Explain Agent Loop and JSONL persistence on presentation slides while keeping terminal footage focused on normal use.

## Production workflow

1. Record authentication guidance separately from sensitive browser input.
2. Capture terminal pre-roll so the PowerShell window can be returned to the foreground.
3. Remove pre-roll and accidental desktop or chat frames.
4. Split footage at login, read, write, edit, bash, and composite-operation boundaries.
5. Put a short explanation slide before each relevant terminal clip.
6. Export H.264 at `1920x1080`, `30 fps`, `yuv420p`.
7. Keep the final duration between 150 and 170 seconds; the canonical export is 165 seconds.
8. Decode the complete MP4 and inspect representative frames before replacing the canonical file.

## Package maintenance

- Render every PPTX slide and fix overflow, clipping, or unintended overlap.
- Keep explanation copy audience-facing; put production notes outside `delivery/`.
- Package only canonical outputs and selected clips in `delivery/` and the ZIP archive.
- Update `manifest.json` and `SHA256SUMS.txt` whenever a canonical artifact changes.

## Required verification

```powershell
$video = 'artifacts\agent-forge-feature-package\delivery\agent-forge-feature-demo.mp4'
C:\portable\ffmpeg.exe -v error -i $video -f null -
C:\portable\ffprobe.exe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate,pix_fmt -of json $video
Get-FileHash -Algorithm SHA256 $video
```

The video must decode without errors, remain at the fixed path, and stay within the approved duration range.
