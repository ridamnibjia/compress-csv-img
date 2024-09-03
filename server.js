const express = require('express');
const app = express();
const port = process.env.PORT || 4000;
const docRouter = require('./router/docRouter');

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.use('/api', docRouter);


app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
  });