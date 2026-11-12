# Озвучка для видео защиты: синтез речи встроенным голосом Windows (локально, без интернета).
# Читает e2e/demo-voice.json и пишет data/voice/<key>.wav. Запуск: npm run voice
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'data/voice'
New-Item -ItemType Directory -Force $outDir | Out-Null
# Реплики нейроголоса (npm run voice) удаляем: видео и микшер предпочитают MP3 и иначе взяли бы старую озвучку.
Get-ChildItem -Path $outDir -Include '*.mp3', '*.wav' -File -Recurse | Remove-Item -Force
$lines = Get-Content -Raw -Encoding UTF8 (Join-Path $root 'e2e/demo-voice.json') | ConvertFrom-Json

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ru-RU' } | Select-Object -First 1
if ($null -eq $voice) { throw 'Не найден русский голос Windows (Параметры → Время и язык → Речь → добавить голос).' }
$synth.SelectVoice($voice.VoiceInfo.Name)
$synth.Rate = 1

# 16 бит, моно, 22 050 Гц: длительность файла = (размер - 44) / 44 100 с.
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($line in $lines) {
  $path = Join-Path $outDir ($line.key + '.wav')
  $synth.SetOutputToWaveFile($path, $format)
  $synth.Speak($line.text)
}
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output ("Голос: {0}; файлов: {1} в {2}" -f $voice.VoiceInfo.Name, $lines.Count, $outDir)
