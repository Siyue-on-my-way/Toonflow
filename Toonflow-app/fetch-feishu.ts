import axios from 'axios';

async function run() {
  try {
    const response = await axios.get('https://transsioner.feishu.cn/wiki/V6aFwuOsEip7mvkWmh0cqVd1n1e');
    console.log(response.data.substring(0, 500));
  } catch (e: any) {
    console.error(e.message);
  }
}
run();
