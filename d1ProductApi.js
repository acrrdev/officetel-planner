// 운영용 상품 API
// 브라우저 -> Cloudflare Worker -> D1
const d1ProductApi = {
    API_BASE_URL: 'https://acrrot123-api.acrrot123.workers.dev',
    SITE_CODE: 'officetel_furniture',

    async getProducts(category) {
        const params = new URLSearchParams({
            category,
            site: this.SITE_CODE
        });

        const response = await fetch(`${this.API_BASE_URL}/api/products?${params}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            let message = `D1 product API error: ${response.status}`;
            try {
                const errorBody = await response.json();
                if (errorBody?.error) message += ` - ${errorBody.error}`;
            } catch (_) {}
            throw new Error(message);
        }

        const data = await response.json();
        return Array.isArray(data) ? data : (data.products || []);
    }
};
