# Publish VidStream to Docker Hub

The GitHub workflow publishes the **application image**. VidStream runs on
the viewer's own server and mounts their local media when it starts. The
image build copies application files. The generated Compose file, local
configuration, catalog, cache, and media stay outside the build context or
image.

## Why the GitHub workflow can be skipped

A local `docker login` authorizes the Docker CLI on your machine. GitHub
Actions runs on a separate runner and signs in with credentials configured
for the GitHub repository. The publish job skips when
`DOCKERHUB_USERNAME` is absent. If publishing is enabled and
`DOCKERHUB_TOKEN` is missing, the job stops with a configuration error.

## Configure the GitHub repository

1. In Docker Hub, open **My Hub → Repositories → Create repository**.
   Choose the namespace you control and name the repository **vidstream**.
   Choose **Public** if you want anyone to be able to pull it. A private
   image requires each machine to sign in with pull access.
   [Create a Docker Hub repository](https://docs.docker.com/docker-hub/repos/create/)
2. In Docker Hub account settings, create a personal access token with
   **Repo Read & Write**. Give it an expiration date. The workflow uses it
   to push tags and needs no delete permission.
   [Personal access tokens](https://docs.docker.com/security/access-tokens/)
3. In the GitHub repository's **Settings → Secrets and variables →
   Actions → Variables**, add `DOCKERHUB_USERNAME` with your Docker ID.
   For the maintainer's expected destination, this is `5u8han`.
   [Repository variables](https://github.com/5u8han/VidStream/settings/variables/actions)
4. In the **Secrets** tab, add a repository secret named
   `DOCKERHUB_TOKEN` with the token from step 2. Keep the token in the
   secret field and out of source files, terminal arguments, and screenshots.
   [Repository secrets](https://github.com/5u8han/VidStream/settings/secrets/actions)
5. In GitHub **Actions → Validate Stream**, open the successful push run for
   the current `main` commit and choose **Re-run all jobs**, or let the
   next push to `main` start validation. After validation succeeds, open
   the **Publish VidStream to Docker Hub** run and check its result.
   [Repository Actions](https://github.com/5u8han/VidStream/actions)

The publish workflow builds and smoke-tests Linux AMD64 and ARM64 images.
It checks that the validated commit is still `main` and publishes a
multi-platform `latest` tag and a `sha-<commit>` tag. When the token
expires, replace the secret with a new write token and repeat step 5.

## Verify the published image

```sh
docker buildx imagetools inspect docker.io/5u8han/vidstream:latest
```

This reads the registry's manifest and displays its platform entries. Look
for `linux/amd64` and `linux/arm64`. It creates no containers or volumes.
If you publish under another Docker ID, use that namespace in the command
and set `VIDSTREAM_IMAGE` to its full image reference for fresh Start-Here
installs.

Existing guided setups use the `image:` recorded in their private
`compose.yaml`. A setup that uses `vidstream-starter:local` continues
using its local builds. To adopt the published image, edit that field to
your chosen tag and use the registry-image update commands in the
[command reference](COMMANDS.md).

## Publish from a workstation

The GitHub workflow is the usual release path. If you need to build and push
from a workstation, make sure the checked-out commit is the version you want
to distribute, Docker has push access, and Buildx supports both platforms.
Use a unique tag when testing publication.

```sh
bash scripts/build-multiarch.sh docker.io/5u8han/vidstream:local-test --push
```

This creates a local Buildx builder if needed, builds the two architectures,
and uploads the image to the specified Docker Hub repository. Replace the
namespace and tag with ones you control. It writes Docker build cache and
registry artifacts. It starts no VidStream service and uses no media mounts.
