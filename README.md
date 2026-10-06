# steamrip-addon

opengameinstaller support for steamrip. a fat-addons project.

## Installing from an archive you already downloaded

When SteamRIP has a match for a game, the search offers a second option, "<game> (install from downloaded archive)". Pick it if you already downloaded the archive in your browser (for example from Gofile or bzzhr). The addon asks for the file (`.rar`, `.zip` or `.7z`; for a multi-part set choose any part), then extracts it, finds the game executable and sets it up exactly like a normal SteamRIP download. Your archive is only read: it is never moved, modified or deleted.

On Linux the archive is extracted with the same tool as normal downloads (`unrar`, or `unar` as a fallback). `unrar` opens only RAR files, so `.zip` and `.7z` archives need `unar` installed.

## About this fork

This is ShockStruck's fork of [fat-addons/steamrip-addon](https://gitlab.com/fat-addons/steamrip-addon). The original code and its authorship belong to fat-addons (shar); this fork carries changes that have not yet landed upstream.

Upstream ships no licence: there is no `LICENSE` file and no `license` field in `package.json`. This fork adds none and claims none. Upstream is hosted on GitLab, not GitHub, so GitHub's terms for forking public repositories do not cover it; without a licence, the rights in the upstream code stay with its author.

## Credits

GoFile download handling is based on [ltsdw/gofile-downloader](https://github.com/ltsdw/gofile-downloader).
