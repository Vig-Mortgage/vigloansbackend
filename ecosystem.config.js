module.exports = {
  apps: [{
    name: "vigloans-backend-v2",
    script: "app.js",

    // ── Contencion del radio de dano ──────────────────────────────────────
    //
    // Este proceso comparte instancia con `vigloans-backend` (v1), que es el
    // backend que hoy atiende la app en produccion. Dos vCPU y 7.8 GB para
    // cinco procesos de pm2. Si v2 se desmadra, la maquina empieza a hacer
    // swap y se lleva a v1 con ella: un fallo de la precualificacion se
    // convierte en una caida de la app.
    //
    // Importa mas desde que existe `POST /prequalify/leads/:id/documents`, que
    // mantiene el archivo EN MEMORIA para poder verificar sus primeros bytes
    // antes de escribirlo (hasta 10 MB por subida). Es un perfil de memoria
    // que v1 nunca ha tenido.
    //
    // 600 MB es ~6x el estado normal (~100 MB), asi que no salta por una
    // rafaga legitima; salta por una fuga o por una avalancha de subidas. Y
    // cuando salta, pm2 reinicia SOLO este proceso.
    max_memory_restart: "600M",

    // Un reinicio inmediato tras un fallo de arranque produce un bucle
    // apretado que consume la CPU que v1 necesita. Con 4 s entre intentos, un
    // proceso que no arranca deja de ser un problema para el vecino.
    restart_delay: 4000,

    // Sin esto pm2 cuenta como "estable" un proceso que muere a los 2 s, y el
    // contador de reinicios inestables nunca se dispara.
    min_uptime: "30s",

    // NO se pone `max_restarts`: haria que pm2 se rindiera y dejara la
    // precualificacion caida hasta que alguien lo mire. Con el retardo de
    // arriba, un bucle de reinicios ya no amenaza a v1, asi que preferimos que
    // siga intentandolo.

    env: {
      PORT: 8081,
      AWS_REGION: process.env.AWS_REGION || 'us-east-1',
      // Secrets Manager
      SM_AWS_ACCESS_KEY_ID: process.env.SM_AWS_ACCESS_KEY_ID,
      SM_AWS_SECRET_ACCESS_KEY: process.env.SM_AWS_SECRET_ACCESS_KEY,
      // S3
      S3_AWS_ACCESS_KEY_ID: process.env.S3_AWS_ACCESS_KEY_ID,
      S3_AWS_SECRET_ACCESS_KEY: process.env.S3_AWS_SECRET_ACCESS_KEY,
    }
  }]
}
