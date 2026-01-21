
const mysql = require('mysql2/promise');

class Database {
    constructor() {
        this.pool = mysql.createPool({
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: process.env.DB_PORT || 19693,
            ssl: {
                rejectUnauthorized: false,  // CHANGE THIS LINE - Accept self-signed certs
                ca: `-----BEGIN CERTIFICATE-----
MIIEUDCCArigAwIBAgIUKiqk/u+ik2fHMGykJFB4Owz1WhUwDQYJKoZIhvcNAQEM
BQAwQDE+MDwGA1UEAww1ZWQ3MzI5Y2YtZTY4YS00ZDRhLTllODItN2UzZmFjMzkz
NjEyIEdFTiAxIFByb2plY3QgQ0EwHhcNMjYwMTE4MTIzNjAyWhcNMzYwMTE2MTIz
NjAyWjBAMT4wPAYDVQQDDDVlZDczMjljZi1lNjhhLTRkNGEtOWU4Mi03ZTNmYWMz
OTM2MTIgR0VOIDEgUHJvamVjdCBDQTCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCC
AYoCggGBAMkpMkjhF9nHE1PyqNUITpKLRQylaN1KTJoNSRVwtD5Tk8Og/vjMBeeG
Aj5RLdf42tkMmZ+9cIbsFg6IC+s9FvBsypHAqn50pu6EAzkbcIBfqgro3Q5PK21D
NbmmqqL0z5Eai0gsGwad5fQJ2NrdK4zNK9vHKPeLidxgjO0F0otCOcFWFpH931LB
bl9lAvYKoN7PjuIoydLZKvlwNLPynDh/uoGYxk7VW43Rso3iTd5zkYqIl4AEVzxg
bFvb4w5KnoF4x+xCtdlYu7IJFuaeFQ9DRd43fQhlvre/7h+ZjRq6Pu7D/DErSxBv
qUxCvwmnGB45OFEKae2lIdVEvmUxZVQCjpEMDWqFl9DePqk7bkPFeHiX7SiNAjPl
sp4VhlnqS1GAYhu3U2rOCauDNbYgea2gxZIdCOhSCznZ2e9gpBnqe8EzubXXiOYt
VHtfUkvSd4QXfQ8vKWNzWaO58F/Q0wfBMqK3IBNQEV3hNUbeiB/DohddPw8cbP6h
bZvzDwkmQwIDAQABo0IwQDAdBgNVHQ4EFgQUBCAdbwxSOZFxMqG7s90mR5VeG2kw
EgYDVR0TAQH/BAgwBgEB/wIBADALBgNVHQ8EBAMCAQYwDQYJKoZIhvcNAQEMBQAD
ggGBAH/YKSCEQdwlTjrc4d1DQb7thQO4RY7jFDEkWJNqs2jhtJj+3gEA659BhIyV
YAFH6GM5feDQlMX+bBtJPP7iaBjoMZxPntnYphHO5TpXsxTOGRTR7Q64qMwsrJp4
qz9Zye5SeAflGVayvEHKz3ShFdc7802hC7+PqSsf+I7Fo4dlCz7WGLWq8lX7OWCq
wTwZ7l7OxDveakw1bWNCr66u9VtoCnkL7Gg/4/jFEeliAsvWA2aAJxxSI/qUXqkz
YgnVzFp6uc5X0B5eNL7RYbQjYkOBZt8cJOpVZ7D3rlRw3oC3hbLrPuDbu6uPQGaJ
tq3y7phqJUOIPktwLipSgxk1K9UOKwvQCctEsxs3/fgpDHbEXzgkTimV8G0AD6WO
fbZMfoNTIHNPltFHBLaB3D4dKlqOs5riH8omEgbbxDkxFnf0E9+ZBGuI6/fj8ZqM
rYnAXHNKq+M+kgdsY8e3YW3EExG2FAu8ZPxYpPjI2RIbHhUw4UBvWuBTv8vUuix8
AL3rig==
-----END CERTIFICATE-----`
            },
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // For debugging
        console.log('testenv');
    }

    async query(sql, params) {
        try {
            const [results] = await this.pool.execute(sql, params);
            return results;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async getConnection() {
        return await this.pool.getConnection();
    }
}

module.exports = new Database();