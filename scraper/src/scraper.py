import json
import re
import time
from functools import reduce

from bs4 import BeautifulSoup

PRELOADED_STATE_RE = re.compile(r'window\.__PRELOADED_STATE__\s*=\s*')
IMAGE_URL_SEPARATOR = '|'

PAGE_URL_SUFFIX = '-pagina-'
HTML_EXTENSION = '.html'

FEATURE_UNIT_DICT = {
    'm²': 'square_meters_area',
    'amb': 'rooms',
    'dorm': 'bedrooms',
    'baño': 'bathrooms',
    'baños': 'bathrooms',
    'coch' : 'parking',
    }

FEATURE_PATTERN = re.compile(r'(\d+(?:\.\d+)?)\s+(m²|amb|dorm|baños?|coch)')

LABEL_DICT = {
    'POSTING_CARD_PRICE' : 'price',
    'expensas' : 'expenses',
    'POSTING_CARD_LOCATION' : 'location',
    'POSTING_CARD_DESCRIPTION' : 'description',
}

SKIP_LABELS = {
    'CARD_FAV',
    'CARD_VIEWPHONE',
    'CARD_WHATSAPP',
    'CARD_CONTACT_MODAL',
    'POSTING_CARD_GALLERY',
}

class Scraper:
    def __init__(self, browser, base_url, max_page=None):
        self.browser = browser
        self.base_url = base_url
        self.max_page = max_page

    def scrap_page(self, page_number):
        if page_number == 1:
            page_url = f'{self.base_url}{HTML_EXTENSION}'
        else:
            page_url = f'{self.base_url}{PAGE_URL_SUFFIX}{page_number}{HTML_EXTENSION}'

        print(f'URL: {page_url}')

        page = self.browser.get_text(page_url)

        soup = BeautifulSoup(page, 'lxml')
        data_by_id = self.extract_data_by_posting_id(soup)
        estate_posts = soup.find_all('div', attrs = {'data-posting-type' : True})
        estates = []
        for estate_post in estate_posts:
            estate = self.parse_estate(estate_post, data_by_id)
            estates.append(estate)
        return estates

    def extract_data_by_posting_id(self, soup):
        script = soup.find('script', id='preloadedData')
        if script is None or not script.string:
            return {}
        match = PRELOADED_STATE_RE.search(script.string)
        if match is None:
            return {}
        try:
            data, _ = json.JSONDecoder().raw_decode(script.string[match.end():])
        except json.JSONDecodeError:
            return {}
        listings = data.get('listStore', {}).get('listPostings', [])
        result = {}
        for listing in listings:
            posting_id = str(listing.get('postingId', ''))
            if not posting_id:
                continue
            pictures = listing.get('visiblePictures', {}).get('pictures', []) or []
            urls = []
            for pic in sorted(pictures, key=lambda p: p.get('order', 0)):
                url = pic.get('url730x532') or pic.get('url360x266')
                if url:
                    urls.append(url.split('?')[0])
            result[posting_id] = {
                'images': urls,
                'location': listing.get('postingLocation') or {},
            }
        return result

    def scrap_website(self):
        page_number = 1
        estates = []
        estates_scraped = 0
        estates_quantity = self.get_estates_quantity()
        while estates_quantity > estates_scraped:
            if self.max_page is not None and page_number > self.max_page:
                print(f'Reached max page limit ({self.max_page}). Stopping.')
                break
            print(f'Page: {page_number}')
            estates += self.scrap_page(page_number)
            page_number += 1
            estates_scraped = len(estates)
            time.sleep(3)

        return estates


    def get_estates_quantity(self):
        page_url = f'{self.base_url}{HTML_EXTENSION}'
        page = self.browser.get_text(page_url)
        soup = BeautifulSoup(page, 'lxml')
        soup.find_all('h1')[0].text

        estates_quantity = re.findall(r'\d+\.?\d+', soup.find_all('h1')[0].text)[0]

        estates_quantity = estates_quantity.replace('.', '')

        estates_quantity = int(estates_quantity)
        return estates_quantity

    def parse_estate(self, estate_post, data_by_id=None):
        data_qa = estate_post.find_all(attrs={'data-qa': True})
        estate = {}
        estate['url'] = estate_post.get_attribute_list('data-to-posting')[0]
        estate['posting_id'] = estate_post.get_attribute_list('data-id')[0]
        estate['posting_type'] = estate_post.get_attribute_list('data-posting-type')[0]
        if data_by_id is not None:
            extra = data_by_id.get(estate['posting_id'], {})
            urls = extra.get('images', [])
            estate['image_urls'] = IMAGE_URL_SEPARATOR.join(urls)
            estate['image_count'] = len(urls)
            estate.update(self.parse_location(extra.get('location') or {}))
        for data in data_qa:
            label = data['data-qa']
            if label in SKIP_LABELS:
                continue
            if label in ['POSTING_CARD_PRICE', 'expensas']:
                currency_value, currency_type = self.parse_currency_value(data.get_text())
                estate[LABEL_DICT[label] + '_' + 'value'] = currency_value
                estate[LABEL_DICT[label] + '_' + 'type'] = currency_type
            elif label in ['POSTING_CARD_LOCATION', 'POSTING_CARD_DESCRIPTION']:
                text = self.parse_text(data.get_text())
                estate[LABEL_DICT[label]] = text
            elif label in ['POSTING_CARD_FEATURES']:
                features = self.parse_features(data.get_text())
                estate.update(features)
            elif label == 'POSTING_CARD_PUBLISHER':
                estate['publisher_logo'] = data.get_attribute_list('src')[0]
            else:
                text = self.parse_text(data.get_text())
                if text:
                    estate[label] = text
        return estate

    def parse_location(self, location):
        address = location.get('address') or {}
        loc = location.get('location') or {}
        city = loc.get('parent') or {}
        geo = (location.get('postingGeolocation') or {}).get('geolocation') or {}
        return {
            'address': address.get('name'),
            'address_visibility': address.get('visibility'),
            'neighborhood': loc.get('name'),
            'location_label': loc.get('label'),
            'city': city.get('name'),
            'latitude': geo.get('latitude'),
            'longitude': geo.get('longitude'),
        }

    def parse_currency_value(self, text):
        try:
            currency_value = re.findall(r'\d+\.?\d+', text)[0]
            currency_value = currency_value.replace('.', '')
            currency_value = int(currency_value)
            currency_type = re.findall(r'(USD)|(ARS)|(\$)', text)[0]
            currency_type = [x for x in currency_type if x != ''][0]
            return currency_value, currency_type
        except:
            return text, None

    def parse_text(self, text):
        text = text.replace('\n', '')
        text = text.replace('\t', '')
        text = text.strip()
        return text

    def parse_features(self, text):
        features_appearance = {column: 0 for column in FEATURE_UNIT_DICT.values()}
        features = {}
        for value, unit in FEATURE_PATTERN.findall(text):
            column_base = FEATURE_UNIT_DICT[unit]
            column = f'{column_base}_{features_appearance[column_base]}'
            features_appearance[column_base] += 1
            features[column] = value
        return features
