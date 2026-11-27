#pragma once
// DIV Deck v1 - hardware configuration
// PCB header J1 (left -> right, seen from the front of the board):
//   1 GND   2 5V   3 LED   4 R2   5 R1   6 R0   7 C0   8 C1   9 C2   10 C3   11 C4
// Wire each header pin to the ESP32 DevKit pin listed below (dupont F-F jumpers).

#include <Arduino.h>

constexpr uint8_t ROWS = 3;
constexpr uint8_t COLS = 5;
constexpr uint8_t KEYS = ROWS * COLS;

// Rows are driven LOW one at a time (outputs). Header R0/R1/R2.
constexpr uint8_t ROW_PINS[ROWS] = {25, 26, 27};
// Columns are read with internal pull-ups (inputs). Header C0..C4.
// All five are full GPIOs with pull-ups on the classic ESP32 (no input-only pins 34-39).
constexpr uint8_t COL_PINS[COLS] = {32, 33, 13, 14, 4};

// SK6812MINI-E chain, through the 74AHCT1G125 level shifter on the PCB. Header "LED".
constexpr uint8_t LED_PIN = 18;
constexpr uint8_t LED_COUNT = 15;

// Brightness cap: 15 LEDs at full white draw ~0.9 A, too much for the DevKit's USB.
// 96/255 keeps the worst case around 0.35 A.
constexpr uint8_t BRIGHTNESS_MAX = 96;
constexpr uint8_t BRIGHTNESS_DEFAULT = 48;

// Optional 0.96" SSD1306 OLED (v1.4 pod): VCC -> 3V3, GND -> GND, SDA -> GPIO21, SCL -> GPIO22.
constexpr uint8_t OLED_SDA = 21;
constexpr uint8_t OLED_SCL = 22;
#define OLED_ROTATION U8G2_R2           // the pod holds the display upside down (header toward the keys)

constexpr uint32_t SERIAL_BAUD = 115200;
constexpr uint8_t DEBOUNCE_MS = 5;
constexpr uint32_t HOST_TIMEOUT_MS = 15000;  // generous: macOS can delay a background app's PING by seconds   // no PING for this long -> standalone mode

// Key index k = row * COLS + col, (0,0) = top-left seen from the front.
// The LED data chain is a serpentine: row 0 left->right, row 1 right->left, row 2 left->right.
inline uint8_t ledForKey(uint8_t k) {
  uint8_t r = k / COLS, c = k % COLS;
  return (r % 2 == 0) ? r * COLS + c : r * COLS + (COLS - 1 - c);
}
