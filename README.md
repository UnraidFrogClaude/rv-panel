# RV Panel

A single-page panel for an older iPad (iPadOS 16), opened in the Bluefy browser.
It talks to the RV's equipment directly over Bluetooth. Experimental: tested against
recorded data and simulated devices, not yet against real equipment.

| Equipment | Reads | Controls |
|---|---|---|
| LiTime battery | Charge, voltage, current, temperature, cells | None, on purpose |
| EasyTouch thermostat | Temperature, mode, fan, setpoints | Mode, temperature (60-90 F), fan |
| EasyStart | Current, start peak, faults | None, on purpose |
| Victron solar charger or battery monitor | Instant Readout, if the browser can receive it | None, broadcasts are one-way |
| Starlink | Link to the dish's own page | None |

## First test at the RV
1. Force-close the LiTime, EasyTouch and EasyStart apps. Most accessories take one connection at a time.
2. Open the panel's https address in Bluefy and allow Bluetooth.
3. Leave controls locked. Connect the battery first and compare it with the LiTime app's numbers.
4. Setup: enter the Micro-Air sign-in, connect the thermostat, compare with the wall display.
5. Only then unlock and change the temperature by one degree. Watch the wall display.
6. If anything fails: Setup, Diagnostics, Copy log.

## Safety notes
- Controls start locked and lock again when the panel is put away.
- A change shows as confirmed only when the thermostat reports it back.
- Readings over a minute old are dimmed and their controls disabled.
- Keep the wall thermostat and the makers' apps as backup. Do not rely on this for alarms,
  or for keeping pets or pipes safe.
- "Remember" stores the sign-in unencrypted on the iPad. Set a passcode if you use it.

## Develop
`npm test` runs the decoder tests. Serve the folder on localhost and add `?sim` for simulated devices.

## Credits
Protocol details and test frames: aiobmsble (Apache-2.0), victron-ble, mbhewitt/easytouch,
k3vmcd/ha-micro-air-easytouch, DerekSeaman/ESPHome-Micro-Air-EasyStart. The code here is written fresh.
Not affiliated with LiTime, Micro-Air, Victron or Starlink.
