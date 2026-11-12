"""Озвучка видео защиты нейросетевым голосом Microsoft (edge-tts).

Читает e2e/demo-voice.json и пишет data/voice/<key>.mp3 (24 кГц, 48 кбит/с, моно).
Текст реплик отправляется в облачный сервис синтеза речи Microsoft.
Без интернета используйте npm run voice:offline (встроенный голос Windows).
Запуск: npm run voice   (нужен пакет: python -m pip install edge-tts)
"""
import asyncio
import json
import sys
from pathlib import Path

import edge_tts

VOICE = 'ru-RU-SvetlanaNeural'  # мужской голос: ru-RU-DmitryNeural
RATE = '+0%'
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'voice'


async def main() -> None:
    lines = json.loads((ROOT / 'e2e' / 'demo-voice.json').read_text(encoding='utf-8'))
    OUT.mkdir(parents=True, exist_ok=True)
    # Старые реплики другого голоса удаляем, чтобы в видео не попала смесь.
    for old in [*OUT.glob('*.wav'), *OUT.glob('*.mp3')]:
        old.unlink()
    for line in lines:
        await edge_tts.Communicate(line['text'], VOICE, rate=RATE).save(str(OUT / f"{line['key']}.mp3"))
    print(f'Голос: {VOICE}; реплик: {len(lines)} в {OUT}')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:  # сеть или сервис недоступны — понятное сообщение вместо трассировки
        sys.exit(f'Не удалось синтезировать речь: {error}. Проверьте интернет или используйте npm run voice:offline')
