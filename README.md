# Camera Link

A small WebRTC camera streaming site. The iPhone sender transmits camera video and microphone audio; an Android browser automatically attempts to join as viewer.

## Render setup
- Build command: `npm install`
- Start command: `npm start`
- Environment variables: `TURN_USERNAME` and `TURN_CREDENTIAL`

Keep TURN credentials in Render Environment, not in GitHub.

## Use
1. Deploy this project to Render over HTTPS.
2. Open the site on iPhone and tap **Увімкнути камеру та мікрофон**. Allow camera and microphone access.
3. Open the same site on Android. It automatically attempts to join as viewer.
4. If Android does not play audio automatically, tap **Увімкнути звук**.

The two roles use one fixed room name in the client so the user does not have to type a room code. This is convenient but is not private authentication: anyone who knows the public site and room name could potentially attempt to join. Do not use this for sensitive/private monitoring. For private access, add a login or a random pairing secret.

The iPhone browser must remain open in the foreground with the screen awake. iOS may pause camera/microphone streaming when the page is backgrounded or the phone is locked.
