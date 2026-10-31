"""Run the local API as a frozen Windows service executable."""

import logging

import uvicorn

from app.main import app


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=8765, reload=False)


if __name__ == "__main__":
    main()
