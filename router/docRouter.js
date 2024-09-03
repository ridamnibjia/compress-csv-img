const express = require('express');
const router = express.Router();
const multer = require('multer');
const { uploadDoc, getRequestStatus } = require('../controller/docController');

const upload = multer({ dest: 'uploads/' });

router.post('/upload', upload.single('file'), uploadDoc);
router.get('/status/:requestId', getRequestStatus);

module.exports = router;