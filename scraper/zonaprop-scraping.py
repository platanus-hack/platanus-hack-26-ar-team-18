import sys

import pandas as pd

from src import utils
from src.browser import Browser
from src.scraper import Scraper


def ask_max_page():
    while True:
        answer = input('¿Hasta qué página querés scrapear? (entero positivo, vacío = todas): ').strip()
        if answer == '':
            return None
        try:
            value = int(answer)
            if value < 1:
                raise ValueError
            return value
        except ValueError:
            print('Valor inválido. Ingresá un entero positivo o dejá vacío para scrapear todas.')


def main(url, max_page=None):
    base_url = utils.parse_zonaprop_url(url)
    print(f'Running scraper for {base_url}')
    if max_page is not None:
        print(f'Scraping up to page {max_page}')
    print(f'This may take a while...')
    browser = Browser()
    scraper = Scraper(browser, base_url, max_page=max_page)
    estates = scraper.scrap_website()
    df = pd.DataFrame(estates)
    print('Scraping finished !!!')
    print('Saving data to csv file')
    filename = utils.get_filename_from_datetime(base_url, 'csv')
    utils.save_df_to_csv(df, filename)
    print(f'Data saved to {filename}')
    print('Scrap finished !!!')

if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else None
    url = 'https://www.zonaprop.com.ar/departamentos-alquiler.html' if url is None else url
    max_page = ask_max_page()
    main(url, max_page=max_page)
