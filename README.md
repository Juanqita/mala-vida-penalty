# Penalti Mala Vida — WhatsApp-Verified Customer Game

**Penalti Mala Vida** is a lightweight interactive penalty-kick game created as a **customer engagement and acquisition tool for a hidden-kitchen fast-food restaurant in Pereira, Colombia**.

The game is designed to turn a simple promotional activity into an interactive experience: customers access the game, identify themselves using their WhatsApp number, take a penalty kick, and receive a result or reward according to the game's rules.

The system uses a small Node.js API to ensure that **each WhatsApp number can register only one penalty attempt per day**.

## 🎯 Purpose

The project is part of a customer engagement strategy for **Mala Vida**, a hidden-kitchen fast-food concept.

Instead of relying only on traditional promotions, the game provides an interactive way to:

* Attract new customers.
* Increase engagement with the restaurant.
* Encourage customers to interact through WhatsApp.
* Create a recurring daily interaction.
* Connect digital gameplay with restaurant promotions and rewards.
* Collect basic participation data while preventing repeated attempts on the same day.

The frontend is intentionally lightweight and can be served as a static website, while the backend handles participation verification and registration.

## 🕹️ How It Works

The general flow is:

1. The customer opens the game.
2. The customer enters their WhatsApp number.
3. The frontend sends the number to the API.
4. The API checks whether that number has already registered a penalty that day.
5. If the customer has not played that day, the game allows the penalty.
6. When the penalty ends, the result is registered through the API.
7. The same WhatsApp number cannot register another penalty until the following day.

This makes the game suitable for promotional campaigns where participation needs to be limited to **one attempt per customer per day**.

## 🏗️ Project Structure

```text
mala-vida-penalty/
├── index.html
├── server/
│   ├── index.js
│   └── data/
│       └── shots.json
└── README.md
```

### Frontend

`index.html` contains the complete game interface and its configuration.

### Backend

`server/index.js` provides the API responsible for:

* Checking whether a phone number can play.
* Registering completed penalty attempts.
* Providing a health-check endpoint.

Participation data is currently stored in:

```text
server/data/shots.json
```

## 🚀 Running Locally

### Requirements

You only need:

* Node.js
* A modern web browser

### 1. Start the API

```bash
cd server
node index.js
```

The API will run at:

```text
http://localhost:3001
```

### 2. Serve the game

From the project root:

```bash
npx --yes serve . -p 8080
```

Then open:

```text
http://localhost:8080
```

Serving the game through a local HTTP server is recommended instead of opening `index.html` directly with `file://`, since browsers may block API requests because of CORS restrictions.

Make sure the frontend configuration points to the local API:

```javascript
const CONFIG = {
  apiBaseUrl: "http://localhost:3001",
  defaultCountryCode: "57"
};
```

## ⚙️ Configuration

The main frontend configuration is located inside `index.html`.

| Field                | Description                                                 |
| -------------------- | ----------------------------------------------------------- |
| `apiBaseUrl`         | Base URL of the backend API                                 |
| `defaultCountryCode` | Default country code without `+`. `57` is used for Colombia |

### Server Environment Variables

The backend supports the following environment variables:

| Variable      | Description             | Default |
| ------------- | ----------------------- | ------- |
| `PORT`        | Port used by the API    | `3001`  |
| `CORS_ORIGIN` | Allowed frontend origin | `*`     |

For example:

```bash
PORT=3001
CORS_ORIGIN=https://your-game-domain.com
```

## 🔌 API

### `POST /api/check`

Checks whether a WhatsApp number is allowed to play.

Request:

```json
{
  "phone": "573001234567"
}
```

Response:

```json
{
  "allowed": true,
  "result": {}
}
```

If the number has already played that day, the API returns `allowed: false`.

### `POST /api/register`

Registers the result of the penalty.

This endpoint is called when the player finishes the game.

### `GET /api/health`

Checks whether the backend is running.

Example:

```text
GET http://localhost:3001/api/health
```

## 💾 Data Storage

The current implementation uses a JSON file for persistence:

```text
server/data/shots.json
```

This approach keeps the project simple and easy to deploy for an initial promotional campaign.

For a larger production deployment, the storage layer could be migrated to a database such as PostgreSQL without changing the core game experience.

## 🌎 Production Deployment

The frontend and backend can be deployed independently.

### Backend

Deploy the `server/` directory to a Node.js-compatible hosting provider such as:

* Railway
* Render
* Fly.io
* A VPS
* Other Node.js hosting platforms

After deployment, obtain the public API URL.

For example:

```text
https://api.example.com
```

Then update the frontend:

```javascript
const CONFIG = {
  apiBaseUrl: "https://api.example.com",
  defaultCountryCode: "57"
};
```

### Frontend

The static game can be hosted using:

* A CDN
* Static hosting
* GitHub Pages
* Netlify
* Vercel
* Another static web host

The backend's `CORS_ORIGIN` should then be configured to allow the frontend's production domain.

Example:

```bash
CORS_ORIGIN=https://game.example.com
```

## 🔐 Participation Control

The main business rule is:

> **One WhatsApp number = one penalty attempt per day.**

The backend is responsible for enforcing this rule rather than relying exclusively on frontend logic.

This prevents a user from simply refreshing the page or reopening the game to obtain another attempt.

## 🚧 Future Improvements

Possible future iterations include:

* PostgreSQL or another persistent database.
* WhatsApp Business API integration.
* Automatic reward delivery through WhatsApp.
* Unique promotional codes.
* Customer statistics and dashboards.
* Campaign and participation analytics.
* Leaderboards.
* Multiple game modes.
* Reward history.
* Authentication and stronger abuse prevention.
* Admin panel for restaurant staff.
* Integration with the restaurant's ordering system.

## 🍔 About the Project

**Penalti Mala Vida** is designed as a bridge between **digital entertainment, WhatsApp engagement, and restaurant marketing**.

The objective is not simply to create a football game, but to create a repeatable customer-acquisition mechanism for a hidden-kitchen fast-food business: a customer discovers the game, interacts with the brand, participates through WhatsApp, and can potentially convert that interaction into a restaurant visit or order.

**Built for Mala Vida — Pereira, Colombia.**
