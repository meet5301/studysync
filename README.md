# StudySync 🌱

A soft, pastel study-buddy web app. Create a private room, share the random 8-character code, and keep a shared focus timer and water-glass progress with your buddy.

## Requirements
- Node.js 18 or newer
- A MongoDB Atlas account and cluster
- Internet connection for Google Fonts and Socket.IO live updates

## 1. Set up MongoDB Atlas
1. In Atlas, open your cluster and create a **Database User** with a password.
2. Under **Network Access**, allow your current IP for local development. For a deployed backend, allow the backend host's outbound IPs if available. `0.0.0.0/0` allows connections from anywhere; use it only if you understand the exposure and have a strong database password.
3. Copy `.env.example` to a new file named `.env`.
4. Replace `<db_password>` with your database user's password. URL-encode special characters in the password (for example, `@` becomes `%40`).
5. Replace `JWT_SECRET` with a long random secret. Do not share or commit `.env`.

The connection string in `.env.example` is based on the Atlas cluster host supplied for this project. The app uses a database named `studysync`.

## 2. Run locally
Open a terminal in this folder and run:

```bash
npm install
npm start
```

Open http://localhost:3000

Create an account, create a room, copy the 8-character room code, and send it to your buddy. Your buddy creates their own account and enters that code under **Join a room**.

## 3. Make the website live
This app has a Node/Express server and Socket.IO, so deploy it as a **Node web service** (for example, Render), not as a static-only website.

1. Push this folder to a private GitHub repository.
2. Create a Render Web Service connected to that repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables in Render:
   - `MONGODB_URI` — the full Atlas URI, with the real password entered only in Render's environment settings
   - `JWT_SECRET` — a long random secret
   - `NODE_ENV` — `production`
6. Set Atlas Network Access to permit the deployed backend to connect.
7. Open the Render URL and share it with your buddy. Both accounts use the same live database.

You can attach a custom domain later. Since Express serves the frontend from `public`, you do not need a separate frontend host for this first release.

## How the room code works
- Every new room gets a random 8-character hexadecimal code.
- Share it privately with your buddy.
- A signed-in user must enter the code to join.
- Rooms allow up to 10 members, to support future small-group study.
- The room is not listed publicly.

## Features included
- Email/password registration and login (passwords are hashed)
- Private rooms with random invitation codes
- Real-time room state updates with Socket.IO
- Shared timer, pause, resume, and finish/save
- Daily water glass progress
- Weekly barrel and monthly reservoir progress indicators
- Study statistics and recent session history
- Editable daily and weekly goals for the room creator
- Responsive light pastel UI

## Important behavior / limitations in this starter
- Each member must press Start. Shared time runs only when every member of the room (at least two people) has marked themselves as studying. If any member pauses, shared progress pauses. This is an accountability tool, not surveillance.
- In this starter, daily/weekly/monthly milestone bars are calculated from the available saved-session statistics and current room timer. Before using it for important long-term records, improve the statistics model to store daily aggregates and exact session start/end intervals.
- The current `finish` endpoint saves the accumulated timer as one session. For more accurate multi-day analytics, pause/finish sessions before midnight and implement timezone-aware daily rollups.
- Add production rate limiting, email verification, password reset, stronger authorization tests, and monitoring before opening the service widely.
- MongoDB is the shared online database. Do not place database credentials in frontend code.
