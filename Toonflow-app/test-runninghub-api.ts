import axios from 'axios';

async function test() {
  try {
    // We don't have the API key, but we can try to see if there's a models endpoint
    const response = await axios.get('https://www.runninghub.ai/openapi/v2', {
      headers: {
        'Authorization': 'Bearer test'
      },
      validateStatus: () => true
    });
    console.log("Status:", response.status);
    console.log("Data:", response.data);
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

test();
