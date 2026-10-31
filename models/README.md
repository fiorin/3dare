# Model weights and offline use

The desktop installer does not include TripoSR checkpoint weights. The first generation downloads the official `stabilityai/TripoSR` checkpoint and the small `facebook/dino-vitb16` image-tokenizer configuration through Hugging Face; this is a model/configuration download, not cloud inference. By default Hugging Face stores these assets outside the executable under `%USERPROFILE%\.cache\huggingface\hub`. The app reuses the cache on later runs, including offline runs. During setup, pass `-ModelCacheDirectory <path>` to store cached assets on a different local drive.

The checkpoint is approximately 1.68 GB. Confirm the current Hugging Face model-card license and distribution terms before redistributing it. TripoSR source is MIT-licensed; its license is retained in `third_party/TripoSR/LICENSE` when building the installer. The project does not commit model weights.
