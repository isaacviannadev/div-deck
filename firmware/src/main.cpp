// DIV Deck v1 firmware - ESP32 DevKit (classic)
// Reads the 3x5 key matrix and drives 15 SK6812MINI-E LEDs.
// Talks to the macOS companion app over USB serial with a line-based text protocol:
//
//   device -> host
//     HELLO DIVDECK <version> KEYS=15 LEDS=15 MODEL=MX ID=<chip>   on boot and in reply to "HELLO"
//     D <k>                                       key k pressed   (k = 0..14, row-major, 0 = top-left)
//     U <k>                                       key k released
//     PONG                                        reply to PING
//     OK / ERR <reason>                           reply to commands
//
//   host -> device
//     HELLO                                       identify
//     PING                                        keep-alive; the host sends it every ~2 s
//     L <k> <rrggbb>                              set the idle colour of key k
//     A <rrggbb>                                  set the idle colour of every key
//     P <rrggbb>                                  colour flashed while a key is held
//     B <0-255>                                   brightness (capped at BRIGHTNESS_MAX)
//     S                                           save colours + brightness to flash
//
// Without a host (no PING for 5 s) the deck runs standalone: keys breathe softly in their
// saved colours and light up on press, so you can test the hardware with no app at all.

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include "config.h"

#ifndef DIVDECK_VERSION
#define DIVDECK_VERSION "dev"
#endif

static Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
static Preferences prefs;

static uint32_t idleColor[KEYS];
static uint32_t pressColor = 0xFFFFFF;
static uint8_t brightness = BRIGHTNESS_DEFAULT;

static bool keyState[KEYS];          // debounced state
static bool keyRaw[KEYS];            // last raw reading
static uint32_t keyChangedAt[KEYS];  // when the raw reading last changed

static uint32_t lastPing = 0;
static bool ledsDirty = true;
static char rxBuf[64];
static uint8_t rxLen = 0;

// ---------------------------------------------------------------- persistence
static void loadSettings() {
  prefs.begin("divdeck", true);
  brightness = min<uint8_t>(prefs.getUChar("bri", BRIGHTNESS_DEFAULT), BRIGHTNESS_MAX);
  pressColor = prefs.getUInt("press", 0xFFFFFF);
  for (uint8_t k = 0; k < KEYS; k++) {
    char key[6];
    snprintf(key, sizeof key, "c%u", k);
    // default palette: a calm blue-to-violet gradient across the deck
    uint32_t def = strip.Color(40 + k * 10, 60, 255 - k * 8);
    idleColor[k] = prefs.getUInt(key, def);
  }
  prefs.end();
}

static void saveSettings() {
  prefs.begin("divdeck", false);
  prefs.putUChar("bri", brightness);
  prefs.putUInt("press", pressColor);
  for (uint8_t k = 0; k < KEYS; k++) {
    char key[6];
    snprintf(key, sizeof key, "c%u", k);
    prefs.putUInt(key, idleColor[k]);
  }
  prefs.end();
}

// ---------------------------------------------------------------- matrix
static void setupMatrix() {
  for (uint8_t r = 0; r < ROWS; r++) {
    pinMode(ROW_PINS[r], OUTPUT);
    digitalWrite(ROW_PINS[r], HIGH);
  }
  for (uint8_t c = 0; c < COLS; c++) pinMode(COL_PINS[c], INPUT_PULLUP);
}

// COL2ROW diodes: drive one row LOW, a pressed key pulls its column LOW.
static void scanMatrix() {
  uint32_t now = millis();
  for (uint8_t r = 0; r < ROWS; r++) {
    digitalWrite(ROW_PINS[r], LOW);
    delayMicroseconds(5);
    for (uint8_t c = 0; c < COLS; c++) {
      uint8_t k = r * COLS + c;
      bool pressed = digitalRead(COL_PINS[c]) == LOW;
      if (pressed != keyRaw[k]) {
        keyRaw[k] = pressed;
        keyChangedAt[k] = now;
      } else if (pressed != keyState[k] && now - keyChangedAt[k] >= DEBOUNCE_MS) {
        keyState[k] = pressed;
        Serial.printf("%c %u\n", pressed ? 'D' : 'U', k);
        ledsDirty = true;
      }
    }
    digitalWrite(ROW_PINS[r], HIGH);
  }
}

// ---------------------------------------------------------------- LEDs
static uint32_t scale(uint32_t c, uint8_t f) {
  uint8_t r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
  return strip.Color(r * f / 255, g * f / 255, b * f / 255);
}

static void renderLeds() {
  bool standalone = millis() - lastPing > HOST_TIMEOUT_MS;
  // standalone: gentle breathing between 35% and 100% of the idle colour
  uint8_t breath = 255;
  if (standalone) {
    float t = (millis() % 4000) / 4000.0f;
    breath = 90 + (uint8_t)(165 * (0.5f - 0.5f * cosf(t * 2 * PI)));
  }
  for (uint8_t k = 0; k < KEYS; k++) {
    uint32_t c = keyState[k] ? pressColor : scale(idleColor[k], breath);
    // gamma correction: LEDs respond linearly, eyes don't. Without it mid tones and pastels
    // look washed out and the colours don't match what the app shows on screen.
    strip.setPixelColor(ledForKey(k), strip.gamma32(c));
  }
  strip.setBrightness(brightness);
  strip.show();
}

// ---------------------------------------------------------------- serial protocol
static bool parseHex(const char *s, uint32_t &out) {
  if (strlen(s) != 6) return false;
  char *end;
  out = strtoul(s, &end, 16);
  return *end == '\0';
}

static void hello() {
  // MODEL + ID let the app tell several decks apart (DIV Deck app 0.2+)
  Serial.printf("HELLO DIVDECK %s KEYS=%u LEDS=%u MODEL=MX ID=%012llx\n", DIVDECK_VERSION, KEYS, LED_COUNT, ESP.getEfuseMac());
}

static void handleLine(char *line) {
  char *cmd = strtok(line, " ");
  if (!cmd) return;
  char *a = strtok(nullptr, " ");
  char *b = strtok(nullptr, " ");
  uint32_t col;

  if (!strcmp(cmd, "PING")) {
    lastPing = millis();
    Serial.println("PONG");
  } else if (!strcmp(cmd, "HELLO")) {
    lastPing = millis();
    hello();
  } else if (!strcmp(cmd, "L") && a && b && parseHex(b, col)) {
    int k = atoi(a);
    if (k < 0 || k >= KEYS) { Serial.println("ERR key"); return; }
    idleColor[k] = col; ledsDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "A") && a && parseHex(a, col)) {
    for (uint8_t k = 0; k < KEYS; k++) idleColor[k] = col;
    ledsDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "P") && a && parseHex(a, col)) {
    pressColor = col; Serial.println("OK");
  } else if (!strcmp(cmd, "B") && a) {
    brightness = constrain(atoi(a), 0, BRIGHTNESS_MAX);
    ledsDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "S")) {
    saveSettings(); Serial.println("OK");
  } else {
    Serial.println("ERR unknown");
  }
}

static void pollSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      rxBuf[rxLen] = '\0';
      handleLine(rxBuf);
      rxLen = 0;
    } else if (rxLen < sizeof(rxBuf) - 1) {
      rxBuf[rxLen++] = ch;
    }
  }
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.begin(SERIAL_BAUD);
  setupMatrix();
  strip.begin();
  loadSettings();
  // power-on self test: sweep each LED in chain order, then show the idle colours
  strip.setBrightness(brightness);
  for (uint8_t i = 0; i < LED_COUNT; i++) {
    strip.clear();
    strip.setPixelColor(i, strip.Color(255, 255, 255));
    strip.show();
    delay(40);
  }
  hello();
}

void loop() {
  static uint32_t lastScan = 0, lastFrame = 0;
  uint32_t now = millis();
  pollSerial();
  if (now - lastScan >= 1) { lastScan = now; scanMatrix(); }
  bool standalone = now - lastPing > HOST_TIMEOUT_MS;
  if (ledsDirty || (standalone && now - lastFrame >= 20)) {
    lastFrame = now; ledsDirty = false;
    renderLeds();
  }
}
