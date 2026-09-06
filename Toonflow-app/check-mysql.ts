import { execSync } from 'child_process';

const pythonScript = `
import mysql.connector
import json

try:
    conn = mysql.connector.connect(
        host="127.0.0.1",
        port=1886,
        user="toonflow_user",
        password="HzW4G30Ro7jEq56uzUiDUg1l",
        database="toonflow_db"
    )
    cursor = conn.cursor()
    
    cursor.execute("SELECT id FROM o_vendorConfig")
    rows = cursor.fetchall()
    print("Vendors in MySQL DB:")
    for row in rows:
        print(row[0])
        
    cursor.execute("SELECT id FROM o_vendorConfig WHERE id = 'aibotplatform'")
    row = cursor.fetchone()
    if not row:
        print("aibotplatform not found, inserting...")
        input_values = json.dumps({
            "apiKey": "",
            "baseUrl": "https://bus-ie.aibotplatform.com/assistant/vendor-api/v2"
        })
        models = json.dumps([
            { "name": "GPT-4o", "modelName": "gpt-4o", "type": "text", "think": False },
            { "name": "GPT-3.5-Turbo", "modelName": "gpt-3.5-turbo", "type": "text", "think": False }
        ])
        
        cursor.execute("""
            INSERT INTO o_vendorConfig (id, enable, inputValues, models)
            VALUES (%s, %s, %s, %s)
        """, ('aibotplatform', 1, input_values, models))
        
        conn.commit()
        print("Inserted aibotplatform into MySQL database.")
    else:
        print("aibotplatform already exists in MySQL database.")
        
    conn.close()
except Exception as e:
    print("Error:", e)
`;

const fs = require('fs');
fs.writeFileSync('check-mysql.py', pythonScript);

try {
  const result = execSync('python3 check-mysql.py', { encoding: 'utf-8' });
  console.log(result);
} catch (e: any) {
  console.error("Error:", e.message);
}
