const fs = require('fs');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify');
const pool = require('../utils/db');
const sharp = require('sharp');
const axios = require('axios');

const validateCSV = (filePath) => {
    return new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(filePath)
            .pipe(parse({ columns: true, trim: true }))
            .on('data', (data) => results.push(data))
            .on('end', () => {
                const isValid = results.every(row => {
                    return (
                        row['S. No.'] &&
                        row['Product Name'] &&
                        row['Input Image Urls'] &&
                        row['Input Image Urls'].split(',').every(url => url.trim().startsWith('https://'))
                    );
                });
                if (isValid) {
                    resolve(results);
                } else {
                    reject(new Error('Invalid CSV format or data'));
                }
            })
            .on('error', (error) => reject(error));
    });
};

const uploadDoc = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const filePath = req.file.path;
        
        try {
            const validatedData = await validateCSV(filePath);
            
            // Generate a unique request ID
            const requestId = await createRequest();

            // Store the validated data
            await storeProductData(requestId, validatedData);

            // Update request status to 'processing'
            await updateRequestStatus(requestId, 'processing');

            // Clean up the uploaded file
            fs.unlinkSync(filePath);

            // Trigger asynchronous image processing
            processImages(requestId, validatedData);

            res.status(200).json({ 
                message: 'File uploaded and processing started', 
                requestId 
            });
        } catch (validationError) {
            // Clean up the uploaded file
            fs.unlinkSync(filePath);
            return res.status(400).json({ message: validationError.message });
        }
    } catch (error) {
        console.error('Error in uploadDoc:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const createRequest = async () => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'INSERT INTO requests (status) VALUES ($1) RETURNING id',
            ['pending']
        );
        await client.query('COMMIT');
        return result.rows[0].id;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
};

const storeProductData = async (requestId, data) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const row of data) {
            const { 'S. No.': serialNumber, 'Product Name': productName, 'Input Image Urls': inputUrls } = row;
            
            // Insert product
            const productResult = await client.query(
                'INSERT INTO products (request_id, serial_number, product_name) VALUES ($1, $2, $3) RETURNING id',
                [requestId, serialNumber, productName]
            );
            const productId = productResult.rows[0].id;

            // Insert images
            const urls = inputUrls.split(',').map(url => url.trim());
            for (const url of urls) {
                await client.query(
                    'INSERT INTO images (product_id, input_url, processing_status) VALUES ($1, $2, $3)',
                    [productId, url, 'pending']
                );
            }
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
};

const updateRequestStatus = async (requestId, status) => {
    const client = await pool.connect();
    try {
        await client.query(
            'UPDATE requests SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [status, requestId]
        );
    } catch (e) {
        console.error('Error updating request status:', e);
        throw e;
    } finally {
        client.release();
    }
};

const processImages = async (requestId, data) => {
    try {
        const processedData = [];
        for (const row of data) {
            const { 'S. No.': serialNumber, 'Product Name': productName, 'Input Image Urls': inputUrls } = row;
            const inputUrlList = inputUrls.split(',').map(url => url.trim());
            const outputUrls = [];
            
            for (const url of inputUrlList) {
                const outputUrl = await compressImage(url);
                outputUrls.push(outputUrl);
                await updateImageStatus(requestId, url, 'completed', outputUrl);
            }
            
            processedData.push({
                'S. No.': serialNumber,
                'Product Name': productName,
                'Input Image Urls': inputUrls,
                'Output Image Urls': outputUrls.join(', ')
            });
        }
        
        // Generate output CSV
        const outputCsvPath = await generateOutputCsv(processedData);
        
        // Update request status to 'completed'
        await updateRequestStatus(requestId, 'completed');
        
        // Trigger webhook
        await sendWebhookNotification(requestId, outputCsvPath);
    } catch (error) {
        console.error('Error processing images:', error);
        await updateRequestStatus(requestId, 'failed');
    }
};

const compressImage = async (url) => {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data, 'binary');
    const compressedBuffer = await sharp(buffer)
        .jpeg({ quality: 50 })
        .toBuffer();
    
    // In a real-world scenario, you'd upload this to a file storage service
    // and return the new URL. For this example, we'll just return a placeholder.
    return `https://compressed-image-url.com/${Date.now()}.jpg`;
};

const updateImageStatus = async (requestId, inputUrl, status, outputUrl = null) => {
    const client = await pool.connect();
    try {
        await client.query(
            `UPDATE images SET processing_status = $1, output_url = $2, updated_at = CURRENT_TIMESTAMP 
             WHERE product_id IN (SELECT id FROM products WHERE request_id = $3) 
             AND input_url = $4`,
            [status, outputUrl, requestId, inputUrl]
        );
    } catch (e) {
        console.error('Error updating image status:', e);
        throw e;
    } finally {
        client.release();
    }
};

const generateOutputCsv = async (data) => {
    return new Promise((resolve, reject) => {
        const outputPath = `./output_${Date.now()}.csv`;
        stringify(data, { header: true }, (err, output) => {
            if (err) {
                reject(err);
            } else {
                fs.writeFile(outputPath, output, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(outputPath);
                    }
                });
            }
        });
    });
};

const sendWebhookNotification = async (requestId, outputCsvPath) => {
    // In a real-world scenario, you'd retrieve the webhook URL from the database
    // associated with this requestId or user
    const webhookUrl = process.env.WEBHOOK_URL || 'https://example.com/webhook';
    
    try {
        await axios.post(webhookUrl, {
            requestId,
            status: 'completed',
            outputCsvUrl: `https://your-api-domain.com/download/${outputCsvPath}`
        });
    } catch (error) {
        console.error('Error sending webhook notification:', error);
    }
};

const getRequestStatus = async (req, res) => {
    const { requestId } = req.params;
    
    try {
        const client = await pool.connect();
        const result = await client.query('SELECT status FROM requests WHERE id = $1', [requestId]);
        client.release();
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Request not found' });
        }
        
        const status = result.rows[0].status;
        res.json({ requestId, status });
    } catch (error) {
        console.error('Error getting request status:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

module.exports = { uploadDoc, getRequestStatus };