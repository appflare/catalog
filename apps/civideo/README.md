# child-video

[child-video](https://github.com/bitoceango/civideo) (repository `civideo`) by bitoceango
is a private video and audiobook library for children. Parents upload to their own R2
bucket; children watch in upstream's native players, which show only that content, with
no recommendations, ads or outside links. Licensed MIT. The docs are mainly in Chinese,
with an English summary in the README.

## What this entry installs

Only the Worker: it streams the bucket's files to activated devices, keeps watch
progress and parental rules in D1, and signs uploads from the parents' desktop app. The
players (SwiftUI for iOS, iPadOS and macOS; Tauri for Windows and Android) come from
upstream's GitHub releases.

## Notes

- **Activating a device.** A device asks for this app's address and the activation key
  once; the Worker then gives it a token of its own.
- **Adding videos.** Upstream's `cpv` tool uploads from a computer with an R2 API token
  (S3 credentials) for the bucket. The Windows and macOS apps upload too, through signed
  links from the Worker, once the R2 upload keys are set in this app's settings.
- **Database.** Upstream ships `worker/schema.sql` rather than migrations. It creates
  only what is missing and runs on every install and update.
- **Custom domain.** workers.dev addresses are blocked in some regions; attach a domain
  of your own if the devices cannot reach the app.
