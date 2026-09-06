const mysql = require('mysql2/promise');

async function run() {
  try {
    const connection = await mysql.createConnection({
      host: '127.0.0.1',
      port: 1886,
      user: 'toonflow_user',
      password: 'HzW4G30Ro7jEq56uzUiDUg1l',
      database: 'toonflow_db'
    });

    const [rows] = await connection.execute('SELECT id FROM o_vendorConfig');
    console.log("Vendors in MySQL DB:");
    for (const row of rows) {
      console.log(row.id);
    }

    const [existing] = await connection.execute('SELECT id FROM o_vendorConfig WHERE id = ?', ['aibotplatform']);
    if (existing.length === 0) {
      console.log("aibotplatform not found, inserting...");
      await connection.execute(
        'INSERT INTO o_vendorConfig (id, enable, inputValues, models) VALUES (?, ?, ?, ?)',
        [
          'aibotplatform',
          1,
          JSON.stringify({
            apiKey: "",
            baseUrl: "https://bus-ie.aibotplatform.com/assistant/vendor-api/v2"
          }),
          JSON.stringify([
            { name: "GPT-4o", modelName: "gpt-4o", type: "text", think: false },
            { name: "GPT-3.5-Turbo", modelName: "gpt-3.5-turbo", type: "text", think: false }
          ])
        ]
      );
      console.log("Inserted aibotplatform into MySQL database.");
    } else {
      console.log("aibotplatform already exists in MySQL database.");
    }

    await connection.end();
  } catch (e) {
    console.error("Error:", e.message);
  }
}

run();
