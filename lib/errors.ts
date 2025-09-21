import { Data } from "effect";

export class NoGameFoundError extends Data.TaggedError('NoGameFoundError')<{
  query: string;
}> {}

export class SteamSearchError extends Data.TaggedError('SteamSearchError')<{
  query: string;
}> {}

export class ScrapeGameDownloadsError extends Data.TaggedError('ScrapeGameDownloadsError')<{
  game: string;
}> {}

export class NoServiceFoundError extends Data.TaggedError('NoServiceFoundError')<{}> {}
export class InvalidUrlError extends Data.TaggedError('InvalidUrlError')<{
  url: string;
}> {}

export class GofilePasswordRequiredError extends Data.TaggedError('GofilePasswordRequiredError')<{
  url: string;
}> {}

export class GofileScrapeError extends Data.TaggedError('GofileScrapeError')<{
  url: string;
  error: unknown;
}> {}

export class DownloadCatcherError extends Data.TaggedError('DownloadCatcherError')<{
  error: unknown;
}> {}

export class UnknownServiceError extends Data.TaggedError('UnknownServiceError')<{
  name: string;
}> {}

export class FileCryptError extends Data.TaggedError('FileCryptError')<{
  url: string;
  error: unknown;
}> {}

export class FileCryptUrlError extends Data.TaggedError('FileCryptUrlError')<{
  url: string;
}> {}

export class FileCryptRedirectError extends Data.TaggedError('FileCryptRedirectError')<{
  url: string;
}> {}

export class FileCryptBrowserClosedError extends Data.TaggedError('FileCryptBrowserClosedError')<{}> {}

export class FichierError extends Data.TaggedError('FichierError')<{
  url: string;
  error: unknown;
}> {}

export class BuzzHeavierError extends Data.TaggedError('BuzzHeavierError')<{
  url: string;
  error: unknown;
}> {}

export class PixelDrainError extends Data.TaggedError('PixelDrainError')<{
  url: string;
  error: unknown;
}> {}

export class ScraperError extends Data.TaggedError('ScraperError')<{
  error: unknown;
}> {}

export class FileSystemError extends Data.TaggedError('FileSystemError')<{
  path: string;
  error: unknown;
}> {}

export class NetworkError extends Data.TaggedError('NetworkError')<{
  url: string;
  error: unknown;
}> {}
export class NoDownloadFoundError extends Data.TaggedError('NoDownloadFoundError')<{}> {}
export class NoFileFoundError extends Data.TaggedError('NoFileFoundError')<{}> {}
export class RarExtractionError extends Data.TaggedError('RarExtractionError')<{
  path: string;
  error: string;
}> {}
export class InputError extends Data.TaggedError('InputError')<{
  error: string;
}> {}
export class CommonRedistError extends Data.TaggedError('CommonRedistError')<{
  path: string;
  error: string;
}> {}

export class MegaDBError extends Data.TaggedError('MegaDBError')<{
  url: string;
  error: unknown;
}> {}