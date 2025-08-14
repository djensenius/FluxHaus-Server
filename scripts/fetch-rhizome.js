require('dotenv/config');

/*
 * "next_reservation": {
        "start_date": "Thursday, 8/14/2025 9:00 am",
        "type": "Daycare | Full Day",
        "first_name": "David",
        "r_id": "2833",
        "precheck_reservation_id": null
    },
    */
const fetchSchedule = () => {
  fetch(process.env.MODERN_DOG_URL || '', {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: 'bearer ' + process.env.MODERN_DOG_TOKEN,
      'Sec-Fetch-Site': 'same-origin',
      'Accept-Language': 'en-CA,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Mode': 'cors',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      Referer: 'https://moddogkitchener.portal.gingrapp.com/',
      Connection: 'keep-alive',
      Cookie: process.env.MODERN_DOG_COOKIE || '',
      'Sec-Fetch-Dest': 'empty',
      Priority: 'u=3, i',
    },
  }).then((response) => response.json())
    .then((json) => {
      console.log('Fetched Rhizome schedule:', json);
    });
};

fetchSchedule();

