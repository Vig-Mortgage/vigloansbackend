module.exports = {
  apps: [{
    name: "vigloans-backend",
    script: "app.js",
    env: {
      JWT_SECRET_KEY: process.env.JWT_SECRET_KEY,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY
    }
  }]
}
