from pathlib import Path

from PIL import Image

from app.providers.triposr import TripoSRProvider


def test_preprocessing_applies_exif_orientation(tmp_path: Path) -> None:
    path = tmp_path / "oriented.jpg"
    image = Image.new("RGB", (40, 20), "white")
    exif = image.getexif()
    exif[274] = 6
    image.save(path, exif=exif)

    prepared = TripoSRProvider._prepare_image(path, remove_bg=False)

    assert prepared.size == (20, 40)
